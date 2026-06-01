//! Embedded web server: serves the phone remote and exposes REST + WebSocket
//! endpoints that drive the same playback logic as the desktop UI. Advertised
//! on the LAN via mDNS so phones can use `http://<host>.local:<port>`.

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast::error::RecvError;
use tower_http::cors::CorsLayer;

use crate::audio::AudioEngine;
use crate::commands::{self, CueSynth};
use crate::state::CoreState;

const REMOTE_HTML: &str = include_str!("../assets/remote.html");

/// Best-effort primary LAN IPv4 (via the "connect a UDP socket" trick; no
/// packets are actually sent).
pub fn local_ipv4() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()? {
        SocketAddr::V4(a) => Some(*a.ip()),
        _ => None,
    }
}

/// Machine hostname (lowercased) used for the `.local` mDNS name.
pub fn mdns_host() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "worship-pad".to_string())
        .to_lowercase()
}

pub async fn serve(app: AppHandle, port: u16) {
    advertise_mdns(port);

    let router = Router::new()
        .route("/", get(|| async { Html(REMOTE_HTML) }))
        .route("/api/info", get(info))
        .route("/api/state", get(state_handler))
        .route("/api/play/:key", post(play))
        .route("/api/stop", post(stop))
        .route("/api/volume", post(volume))
        .route("/api/preset/:id", post(preset))
        .route("/api/click/enabled", post(click_enabled))
        .route("/api/click/bpm", post(click_bpm))
        .route("/api/click/beats", post(click_beats))
        .route("/api/click/accent", post(click_accent))
        .route("/api/click/volume", post(click_volume))
        .route("/api/cue/speak", post(cue_speak))
        .route("/api/cue/quick/:id", post(cue_quick))
        .route("/api/cue/stop", post(cue_stop))
        .route("/ws", get(ws_upgrade))
        .layer(CorsLayer::permissive())
        .with_state(app);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            eprintln!("[server] phone remote listening on http://0.0.0.0:{port}");
            if let Err(e) = axum::serve(listener, router).await {
                eprintln!("[server] axum error: {e}");
            }
        }
        Err(e) => eprintln!("[server] could not bind port {port}: {e}"),
    }
}

fn advertise_mdns(port: u16) {
    use mdns_sd::{ServiceDaemon, ServiceInfo};

    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[mdns] daemon: {e}");
            return;
        }
    };

    let host = mdns_host();
    let host_name = format!("{host}.local.");
    let ip = local_ipv4().map(|i| i.to_string()).unwrap_or_default();
    let props: &[(&str, &str)] = &[];

    match ServiceInfo::new(
        "_http._tcp.local.",
        "StagePal",
        &host_name,
        ip.as_str(),
        port,
        props,
    ) {
        Ok(info) => {
            let info = info.enable_addr_auto();
            if let Err(e) = daemon.register(info) {
                eprintln!("[mdns] register: {e}");
            } else {
                eprintln!("[mdns] advertising http://{host}.local:{port}");
            }
            // Keep the daemon (and its background thread) alive for the app's life.
            std::mem::forget(daemon);
        }
        Err(e) => eprintln!("[mdns] service info: {e}"),
    }
}

fn map_result(r: Result<(), String>) -> Response {
    match r {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

/// Run a sync command on the blocking pool so it doesn't pin a tokio worker.
/// Cue synthesis shells out to PowerShell (hundreds of ms), and a few of those
/// in flight would otherwise starve the WebSocket and HTTP handlers.
async fn run_blocking<F>(f: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(format!("remote worker panic: {e}")))
}

async fn info(State(app): State<AppHandle>) -> impl IntoResponse {
    let core = app.state::<CoreState>();
    Json(commands::build_info(core.inner()))
}

async fn state_handler(State(app): State<AppHandle>) -> impl IntoResponse {
    let core = app.state::<CoreState>();
    Json(core.snapshot())
}

async fn play(State(app): State<AppHandle>, Path(key): Path<String>) -> Response {
    let r = run_blocking(move || {
        let core = app.state::<CoreState>();
        let engine = app.state::<AudioEngine>();
        let synth = app.state::<CueSynth>();
        commands::play_key_logic(
            &app,
            core.inner(),
            engine.inner(),
            synth.0.as_ref(),
            &key,
        )
    })
    .await;
    map_result(r)
}

async fn stop(State(app): State<AppHandle>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::stop_logic(&app, core.inner(), engine.inner()))
}

#[derive(Deserialize)]
struct VolumeBody {
    volume: f32,
}

async fn volume(State(app): State<AppHandle>, Json(body): Json<VolumeBody>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::set_volume_logic(
        &app,
        core.inner(),
        engine.inner(),
        body.volume,
    ))
}

async fn preset(State(app): State<AppHandle>, Path(id): Path<String>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::set_preset_logic(&app, core.inner(), engine.inner(), &id))
}

#[derive(Deserialize)]
struct EnabledBody { enabled: bool }
#[derive(Deserialize)]
struct BpmBody { bpm: f32 }
#[derive(Deserialize)]
struct BeatsBody { beats: u32 }
#[derive(Deserialize)]
struct AccentBody { accent: bool }

async fn click_enabled(State(app): State<AppHandle>, Json(body): Json<EnabledBody>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::set_click_enabled_logic(
        &app,
        core.inner(),
        engine.inner(),
        body.enabled,
    ))
}

async fn click_bpm(State(app): State<AppHandle>, Json(body): Json<BpmBody>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::set_click_bpm_logic(
        &app,
        core.inner(),
        engine.inner(),
        body.bpm,
    ))
}

async fn click_beats(State(app): State<AppHandle>, Json(body): Json<BeatsBody>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::set_click_beats_logic(
        &app,
        core.inner(),
        engine.inner(),
        body.beats,
    ))
}

async fn click_accent(State(app): State<AppHandle>, Json(body): Json<AccentBody>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::set_click_accent_logic(
        &app,
        core.inner(),
        engine.inner(),
        body.accent,
    ))
}

async fn click_volume(State(app): State<AppHandle>, Json(body): Json<VolumeBody>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::set_click_volume_logic(
        &app,
        core.inner(),
        engine.inner(),
        body.volume,
    ))
}

#[derive(Deserialize)]
struct SpeakBody { text: String }

async fn cue_speak(State(app): State<AppHandle>, Json(body): Json<SpeakBody>) -> Response {
    let r = run_blocking(move || {
        let core = app.state::<CoreState>();
        let engine = app.state::<AudioEngine>();
        let synth = app.state::<CueSynth>();
        commands::cue_speak_logic(
            &app,
            core.inner(),
            engine.inner(),
            synth.0.as_ref(),
            &body.text,
            None,
            None,
        )
    })
    .await;
    map_result(r)
}

async fn cue_quick(State(app): State<AppHandle>, Path(id): Path<String>) -> Response {
    let r = run_blocking(move || {
        let core = app.state::<CoreState>();
        let engine = app.state::<AudioEngine>();
        let synth = app.state::<CueSynth>();
        commands::cue_speak_quick_logic(
            &app,
            core.inner(),
            engine.inner(),
            synth.0.as_ref(),
            &id,
        )
    })
    .await;
    map_result(r)
}

async fn cue_stop(State(app): State<AppHandle>) -> Response {
    let core = app.state::<CoreState>();
    let engine = app.state::<AudioEngine>();
    map_result(commands::cue_stop_logic(&app, core.inner(), engine.inner()))
}

async fn ws_upgrade(State(app): State<AppHandle>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| ws_loop(socket, app))
}

async fn ws_loop(mut socket: WebSocket, app: AppHandle) {
    let mut rx = {
        let core = app.state::<CoreState>();
        if let Ok(txt) = serde_json::to_string(&core.snapshot()) {
            let _ = socket.send(Message::Text(txt)).await;
        }
        core.tx.subscribe()
    };

    loop {
        tokio::select! {
            recv = rx.recv() => match recv {
                Ok(now) => {
                    if let Ok(txt) = serde_json::to_string(&now) {
                        if socket.send(Message::Text(txt)).await.is_err() {
                            break;
                        }
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(_)) => {} // ignore inbound messages
                _ => break,
            },
        }
    }
}
