// Worship Pads — Tauri backend entrypoint.
// Phase 1: hidden-on-boot, system tray, single instance, autostart.
// Phase 2: audio engine (device routing + crossfade playback).
// Phase 3: core state, presets/library, settings persistence.

pub mod audio;
mod commands;
pub mod cues;
pub mod library;
pub mod model;
mod server;
mod state;

use audio::AudioEngine;
use state::CoreState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

/// Show and focus the main settings window (the window boots hidden).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Re-apply saved audio settings to the engine on boot. The click is restored
/// in everything *except* its `enabled` state — we boot stopped so the user
/// isn't surprised by a live click on launch.
fn restore_audio(app: &tauri::AppHandle) {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();

    let (host, device, pad_channels, click_channels, volume, crossfade_ms, click_bpm, click_beats, click_accent, click_volume) = {
        let s = core.settings.lock().unwrap();
        (
            s.output_host.clone(),
            s.output_device.clone(),
            (s.channel_left, s.channel_right),
            (s.click.channel_left, s.click.channel_right),
            s.master_volume,
            s.crossfade_ms,
            s.click.bpm,
            s.click.beats_per_bar,
            s.click.accent,
            s.click.volume,
        )
    };

    let _ = engine.set_volume(volume);
    let _ = engine.set_crossfade(crossfade_ms);
    let _ = engine.set_click_bpm(click_bpm);
    let _ = engine.set_click_beats(click_beats);
    let _ = engine.set_click_accent(click_accent);
    let _ = engine.set_click_volume(click_volume);
    if let Some(device) = device {
        if let Err(e) = engine.set_output(&host, &device, pad_channels, click_channels) {
            eprintln!("[boot] could not restore audio output '{device}' on {host}: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single instance must be the FIRST plugin registered.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AudioEngine::new())
        .setup(|app| {
            // Load persisted settings into managed CoreState.
            let config_path = app
                .path()
                .app_config_dir()
                .map(|d| d.join("settings.json"))
                .unwrap_or_else(|_| std::path::PathBuf::from("settings.json"));
            app.manage(CoreState::load(config_path));

            // Re-bind the saved audio device/channels/volume.
            restore_audio(app.handle());

            // Start the phone-remote web server on the configured port.
            let port = app
                .state::<CoreState>()
                .settings
                .lock()
                .unwrap()
                .server_port;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                server::serve(handle, port).await;
            });

            // Launch on system startup.
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::MacosLauncher;
                app.handle().plugin(tauri_plugin_autostart::init(
                    MacosLauncher::LaunchAgent,
                    None,
                ))?;

                // Register the app to start automatically on login. Only in
                // release builds, so `tauri dev` runs don't add the debug
                // binary to the OS startup list. enable() is idempotent.
                #[cfg(not(debug_assertions))]
                {
                    use tauri_plugin_autostart::ManagerExt;
                    let autostart = app.handle().autolaunch();
                    if !autostart.is_enabled().unwrap_or(false) {
                        if let Err(e) = autostart.enable() {
                            eprintln!("[autostart] could not enable launch-on-login: {e}");
                        }
                    }
                }
            }

            // System tray.
            let open_item = MenuItem::with_id(app, "open", "Open Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Worship Pads")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Hide to tray instead of quitting when the window is closed.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::get_state,
            commands::list_audio_devices,
            commands::set_audio_output,
            commands::set_volume,
            commands::scan_library,
            commands::remove_preset,
            commands::set_preset,
            commands::rename_preset,
            commands::assign_key,
            commands::clear_key,
            commands::set_crossfade,
            commands::play_key,
            commands::stop,
            commands::server_url,
            commands::set_click_enabled,
            commands::set_click_bpm,
            commands::set_click_beats,
            commands::set_click_accent,
            commands::set_click_volume,
            commands::set_click_channels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
