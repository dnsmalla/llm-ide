//! Native application menu, mirroring the frozen Mac app's SwiftUI command groups.
//!
//! The Mac dump (same SwiftUI `WindowGroup`, custom command groups) is the reference:
//!   LLM-IDE: About, [Check for Updates… only with a feed], Services, Hide/Hide Others/Show All, Quit
//!   File: New Window, Close, Close All
//!   Edit: Undo/Redo, Cut/Copy/Paste/Delete/Select All
//!   View: empty
//!   Window: Minimize, Zoom, Bring All to Front, Quick Switch Project…, LLM Chat…, Start/Stop Recording, window list
//!   Help: LLM-IDE Help, Toggle Sidebar
//!
//! Desktop limits are explicit, not faked: New Window is disabled (one authenticated webview; a new window would
//! land signed out), Delete/Writing Tools/AutoFill/Dictation are OS text services the webview handles itself,
//! Start Recording has no desktop capture engine, and Toggle Sidebar has no desktop sidebar. Updates are Sparkle
//! on the Mac. Commands that do exist emit `app-menu` and only navigate the shell.
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let sep = |app: &AppHandle| PredefinedMenuItem::separator(app);

    let about = PredefinedMenuItem::about(app, Some("About LLM-IDE"), None)?;
    let services = PredefinedMenuItem::services(app, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit LLM-IDE"))?;
    let app_menu = SubmenuBuilder::new(app, "LLM-IDE")
        .items(&[&about, &sep(app)?, &services, &sep(app)?, &hide, &hide_others, &show_all, &sep(app)?, &quit])
        .build()?;

    let new_window = MenuItemBuilder::new("New Window").enabled(false).build(app)?;
    let close = PredefinedMenuItem::close_window(app, Some("Close"))?;
    let close_all = MenuItemBuilder::with_id("menu_close_all", "Close All")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .items(&[&new_window, &sep(app)?, &close, &close_all])
        .build()?;

    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .items(&[&undo, &redo, &sep(app)?, &cut, &copy, &paste, &select_all])
        .build()?;

    // The Mac's View menu is empty in this WindowGroup; keep the group so the menu bar structure matches.
    let view = SubmenuBuilder::new(app, "View").build()?;

    // NOTE: not the predefined Minimize: its fixed Cmd+M would swallow the chat's Cmd+M dictation shortcut
    // before the web view ever sees the key.
    let minimize = MenuItemBuilder::with_id("menu_minimize", "Minimize").build(app)?;
    let zoom = PredefinedMenuItem::maximize(app, Some("Zoom"))?;
    let front = PredefinedMenuItem::bring_all_to_front(app, None)?;
    let quick = MenuItemBuilder::with_id("menu_quick_switch", "Quick Switch Project…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let chat = MenuItemBuilder::with_id("menu_chat", "LLM Chat…")
        .accelerator("CmdOrCtrl+Shift+L")
        .build(app)?;
    let main_window = MenuItemBuilder::with_id("menu_window_main", "Main Window").build(app)?;
    let window_list = SubmenuBuilder::new(app, "LLM-IDE").items(&[&main_window]).build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .items(&[&minimize, &zoom, &sep(app)?, &front, &quick, &chat, &sep(app)?, &window_list])
        .build()?;

    let help = MenuItemBuilder::with_id("menu_help", "LLM-IDE Help").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help").items(&[&help]).build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window, &help_menu])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        match event.id().as_ref() {
            "menu_quick_switch" | "menu_chat" | "menu_help" => {
                let _ = app.emit("app-menu", event.id().as_ref());
            }
            "menu_minimize" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }
            "menu_close_all" => {
                for (_, window) in app.webview_windows() {
                    let _ = window.close();
                }
            }
            "menu_window_main" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }
    });
    Ok(())
}
