//! Verify the library scanner maps real pad filenames to keys.
//!   cargo run --example scan_test -- "C:\path\to\folder"

use std::path::Path;

use worshippads_lib::library::scan_preset;
use worshippads_lib::model::Key;

fn main() {
    let folder = std::env::args().nth(1).expect("usage: scan_test <folder>");
    match scan_preset(Path::new(&folder), None) {
        Ok(p) => {
            println!("Preset '{}' — {}/12 keys mapped:\n", p.name, p.files.len());
            for key in Key::ALL {
                match p.files.get(&key) {
                    Some(path) => println!(
                        "  {:>2}  ->  {}",
                        key.as_str(),
                        path.file_name().unwrap().to_string_lossy()
                    ),
                    None => println!("  {:>2}  ->  (missing)", key.as_str()),
                }
            }
        }
        Err(e) => eprintln!("error: {e}"),
    }
}
