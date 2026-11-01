//! Native application menu, mirroring the frozen Mac app's SwiftUI command groups.
//!
//! macOS owns the menu bar: the app menu holds About / Settings / Services / Hide / Quit, followed by
//! File / Edit / View / Window / Help. The Mac's custom commands that the desktop can honour are Settings… (⌘,),
//! Quick Switch Project… (⌘P), LLM Chat… (⇧⌘L) and Help & Guide. Start/Stop Recording and Check for Updates are
//! Mac-only hosts, so they are not invented here. Commands are emitted as `app-menu` events; the webview maps them
//! onto the shell bus (sections), never onto filesystem or shell operations.
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter};

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let sep = |app: &AppHandle| PredefinedMenuItem::separator(app);

    let about = PredefinedMenuItem::about(app, Some("About LLM-IDE"), None)?;
    let settings = MenuItemBuilder::with_id("menu_settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let services = PredefinedMenuItem::services(app, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit LLM-IDE"))?;
    let app_menu = SubmenuBuilder::new(app, "LLM-IDE")
        .items(&[&about, &sep(app)?, &settings, &sep(app)?, &services, &sep(app)?, &hide, &hide_others, &show_all, &sep(app)?, &quit])
        .build()?;

    let close = PredefinedMenuItem::close_window(app, None)?;
    let file = SubmenuBuilder::new(app, "File").items(&[&close]).build()?;

    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .items(&[&undo, &redo, &sep(app)?, &cut, &copy, &paste, &select_all])
        .build()?;

    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let view = SubmenuBuilder::new(app, "View").items(&[&fullscreen]).build()?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let front = PredefinedMenuItem::bring_all_to_front(app, None)?;
    let quick = MenuItemBuilder::with_id("menu_quick_switch", "Quick Switch Project…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let chat = MenuItemBuilder::with_id("menu_chat", "LLM Chat…")
        .accelerator("CmdOrCtrl+Shift+L")
        .build(app)?;
    let window = SubmenuBuilder::new(app, "Window")
        .items(&[&minimize, &front, &sep(app)?, &quick, &chat])
        .build()?;

    let help = MenuItemBuilder::with_id("menu_help", "LLM-IDE Help").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help").items(&[&help]).build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window, &help_menu])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if matches!(id, "menu_settings" | "menu_quick_switch" | "menu_chat" | "menu_help") {
            let _ = app.emit("app-menu", id);
        }
    });
    Ok(())
}
