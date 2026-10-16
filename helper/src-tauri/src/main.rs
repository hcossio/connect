// DevAssist Helper: a tiny desktop app the person being helped double-clicks.
// It listens on 127.0.0.1 only, accepts connections only from the DevAssist
// web app's origins, and injects mouse and keyboard input while the web app
// says control has been allowed. Closing the window or pressing Stop ends it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

const PORT: u16 = 47800;

/// Web origins allowed to connect. Override at build time with
/// DEVASSIST_ORIGINS="https://a.example,https://b.example".
fn allowed_origins() -> Vec<String> {
    option_env!("DEVASSIST_ORIGINS")
        .unwrap_or("https://connect.marcah.com,https://web-production-7e260.up.railway.app,http://localhost:3000")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event {
    Move { x: f64, y: f64 },
    Down { x: f64, y: f64, #[serde(default)] button: u8 },
    Up { x: f64, y: f64, #[serde(default)] button: u8 },
    Wheel { #[serde(default)] dx: f64, #[serde(default)] dy: f64 },
    Text { text: String },
    Keydown {
        key: String,
        #[serde(default)] code: String,
        #[serde(default)] ctrl: bool,
        #[serde(default)] alt: bool,
        #[serde(default)] shift: bool,
        #[serde(default)] meta: bool,
    },
    Keyup {},
    Control { on: bool },
}

// Last status, so the window can show it even if it was emitted before the page loaded.
static LAST_STATUS: Mutex<Option<serde_json::Value>> = Mutex::new(None);

fn status(app: &AppHandle, state: &str, detail: &str) {
    let payload = serde_json::json!({ "state": state, "detail": detail });
    *LAST_STATUS.lock().unwrap() = Some(payload.clone());
    let _ = app.emit("status", payload);
}

#[tauri::command]
fn get_status() -> Option<serde_json::Value> {
    LAST_STATUS.lock().unwrap().clone()
}

// ---------- Input injection (own thread: Enigo isn't Send on every OS) ----------

fn button(b: u8) -> Button {
    match b {
        1 => Button::Middle,
        2 => Button::Right,
        _ => Button::Left,
    }
}

fn special_key(key: &str) -> Option<Key> {
    Some(match key {
        "Enter" => Key::Return,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        " " => Key::Space,
        "Delete" => Key::Delete,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "CapsLock" => Key::CapsLock,
        "F1" => Key::F1, "F2" => Key::F2, "F3" => Key::F3, "F4" => Key::F4,
        "F5" => Key::F5, "F6" => Key::F6, "F7" => Key::F7, "F8" => Key::F8,
        "F9" => Key::F9, "F10" => Key::F10, "F11" => Key::F11, "F12" => Key::F12,
        _ => return None,
    })
}

/// Physical key from KeyboardEvent.code (layout independent), for shortcuts like Ctrl+C.
fn key_from_code(code: &str) -> Option<Key> {
    let c = code.strip_prefix("Key").or_else(|| code.strip_prefix("Digit"))?;
    let ch = c.chars().next()?.to_ascii_lowercase();
    (c.len() == 1).then_some(Key::Unicode(ch))
}

fn inject(enigo: &mut Enigo, (w, h): (i32, i32), ev: Event) -> Result<(), enigo::InputError> {
    let abs = |x: f64, y: f64| {
        let x = (x.clamp(0.0, 1.0) * (w - 1) as f64).round() as i32;
        let y = (y.clamp(0.0, 1.0) * (h - 1) as f64).round() as i32;
        (x, y)
    };
    match ev {
        Event::Move { x, y } => {
            let (x, y) = abs(x, y);
            enigo.move_mouse(x, y, Coordinate::Abs)
        }
        Event::Down { x, y, button: b } => {
            let (x, y) = abs(x, y);
            enigo.move_mouse(x, y, Coordinate::Abs)?;
            enigo.button(button(b), Direction::Press)
        }
        Event::Up { x, y, button: b } => {
            let (x, y) = abs(x, y);
            enigo.move_mouse(x, y, Coordinate::Abs)?;
            enigo.button(button(b), Direction::Release)
        }
        Event::Wheel { dx, dy } => {
            if dy != 0.0 { enigo.scroll(3 * dy.signum() as i32, Axis::Vertical)?; }
            if dx != 0.0 { enigo.scroll(3 * dx.signum() as i32, Axis::Horizontal)?; }
            Ok(())
        }
        Event::Text { text } => enigo.text(&text.chars().take(10_000).collect::<String>()),
        Event::Keydown { key, code, ctrl, alt, shift, meta } => {
            if matches!(key.as_str(), "Control" | "Shift" | "Alt" | "Meta") {
                return Ok(()); // sent as flags along with the real key
            }
            let shortcut = ctrl || alt || meta;
            let special = special_key(&key);
            if special.is_none() && !shortcut && key.chars().count() == 1 {
                return enigo.text(&key); // printable char, respects remote layout
            }
            let Some(k) = special.or_else(|| key_from_code(&code)) else { return Ok(()) };
            let mods: Vec<Key> = [(ctrl, Key::Control), (alt, Key::Alt), (shift, Key::Shift), (meta, Key::Meta)]
                .into_iter()
                .filter_map(|(on, m)| on.then_some(m))
                .collect();
            for m in &mods { enigo.key(*m, Direction::Press)?; }
            let r = enigo.key(k, Direction::Click);
            for m in mods.iter().rev() { enigo.key(*m, Direction::Release)?; }
            r
        }
        Event::Keyup {} | Event::Control { .. } => Ok(()),
    }
}

fn input_thread(rx: mpsc::Receiver<Event>) {
    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(e) => e,
        Err(e) => { eprintln!("cannot create input device: {e}"); return; }
    };
    for ev in rx {
        // Re-read each time so a resolution change mid-session still maps correctly.
        let size = enigo.main_display().unwrap_or((1920, 1080));
        if let Err(e) = inject(&mut enigo, size, ev) { eprintln!("input error: {e}"); }
    }
}

// ---------- Local WebSocket server ----------

async fn serve(app: AppHandle, input: mpsc::Sender<Event>) {
    let listener = match TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(l) => l,
        Err(_) => return status(&app, "error", "Another DevAssist Helper is already running."),
    };
    status(&app, "waiting", "Waiting for DevAssist. Go back to the call.");
    let origins = allowed_origins();

    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let mut origin = String::new();
        let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            let o = req.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
            if origins.iter().any(|a| a == o) {
                origin = o.to_string();
                Ok(resp)
            } else {
                let mut err = ErrorResponse::new(Some("origin not allowed".into()));
                *err.status_mut() = StatusCode::FORBIDDEN;
                Err(err)
            }
        };
        let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, check).await else { continue };

        // One session at a time: handle it here before accepting the next.
        status(&app, "connected", &format!("Connected to {origin}. Nobody is controlling this computer."));
        let mut controlled = false;
        while let Some(Ok(msg)) = ws.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(ev) = serde_json::from_str::<Event>(&text) else { continue };
            match ev {
                Event::Control { on } => {
                    controlled = on;
                    if on {
                        status(&app, "controlled", "Your helper is controlling this computer.");
                    } else {
                        status(&app, "connected", "Control ended. You are in control.");
                    }
                }
                ev if controlled => { let _ = input.send(ev); }
                _ => {}
            }
        }
        status(&app, "waiting", "Disconnected. Waiting for DevAssist.");
    }
}

#[tauri::command]
fn stop(app: AppHandle) {
    app.exit(0);
}

fn main() {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || input_thread(rx));

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![stop, get_status])
        .setup(move |app| {
            tauri::async_runtime::spawn(serve(app.handle().clone(), tx));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DevAssist Helper");
}
