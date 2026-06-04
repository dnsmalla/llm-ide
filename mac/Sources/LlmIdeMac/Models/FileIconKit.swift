import SwiftUI

/// Single source of truth for file-extension icons and colours used throughout the app.
/// All views (FileTreePanel, EditorTabBar, LibraryFileRow) pull from here so icons and
/// colours are guaranteed to match everywhere.
enum FileIconKit {

    // MARK: - Folder

    /// Standard folder colour used across the entire app.
    static let folderColor = Color(red: 0.94, green: 0.76, blue: 0.35)

    // MARK: - File icon (SF Symbol name)

    static func icon(for ext: String) -> String {
        switch ext.lowercased() {
        case "swift":                                       return "swift"
        case "py":                                          return "chevron.left.forwardslash.chevron.right"
        case "ts", "tsx":                                   return "doc.text.fill"
        case "js", "jsx":                                   return "doc.text.fill"
        case "json":                                        return "curlybraces"
        case "yml", "yaml":                                 return "gearshape.fill"
        case "toml":                                        return "gearshape"
        case "md", "markdown":                              return "doc.richtext"
        case "sh", "bash", "zsh":                           return "terminal.fill"
        case "ini", "cfg", "conf", "env":                   return "slider.horizontal.3"
        case "j2", "jinja":                                 return "doc.plaintext"
        case "html", "htm":                                 return "globe"
        case "css", "scss":                                 return "paintbrush.fill"
        case "xml":                                         return "chevron.left.forwardslash.chevron.right"
        case "go":                                          return "swift"
        case "rb":                                          return "doc.text.fill"
        case "rs":                                          return "doc.text.fill"
        case "java", "kt":                                  return "doc.text.fill"
        case "cpp", "c", "h", "m", "mm":                   return "doc.text.fill"
        case "sql":                                         return "cylinder.split.1x2"
        case "tf":                                          return "server.rack"
        case "dockerfile":                                  return "shippingbox.fill"
        case "png", "jpg", "jpeg", "gif",
             "svg", "webp", "heic", "tiff", "bmp":         return "photo"
        case "pdf":                                         return "doc.fill"
        case "txt", "log":                                  return "doc.text"
        case "csv", "tsv":                                  return "tablecells"
        case "xlsx", "xls", "numbers":                      return "tablecells.fill"
        case "pptx", "ppt", "key":                          return "play.rectangle"
        case "docx", "doc", "pages":                        return "doc.text.fill"
        case "zip", "tar", "gz":                            return "archivebox"
        case "makefile":                                    return "wrench.and.screwdriver"
        default:                                            return "doc"
        }
    }

    // MARK: - File colour (VSCode-inspired palette)

    static func color(for ext: String) -> Color {
        switch ext.lowercased() {
        case "swift":                                       return Color(red: 0.98, green: 0.50, blue: 0.28)
        case "py":                                          return Color(red: 0.99, green: 0.82, blue: 0.20)
        case "ts", "tsx":                                   return Color(red: 0.24, green: 0.56, blue: 0.97)
        case "js", "jsx":                                   return Color(red: 0.99, green: 0.82, blue: 0.20)
        case "json":                                        return Color(red: 0.99, green: 0.82, blue: 0.20)
        case "yml", "yaml", "toml":                         return Color(red: 0.97, green: 0.58, blue: 0.20)
        case "md", "markdown":                              return Color(red: 0.30, green: 0.60, blue: 0.95)
        case "sh", "bash", "zsh":                           return Color(red: 0.29, green: 0.78, blue: 0.47)
        case "ini", "cfg", "conf", "env":                   return Color(.secondaryLabelColor)
        case "j2", "jinja":                                 return Color(red: 0.67, green: 0.45, blue: 0.95)
        case "html", "htm":                                 return Color(red: 0.97, green: 0.58, blue: 0.20)
        case "css", "scss":                                 return Color(red: 0.36, green: 0.60, blue: 0.95)
        case "xml":                                         return Color(red: 0.97, green: 0.58, blue: 0.20)
        case "go":                                          return Color(red: 0.40, green: 0.80, blue: 0.85)
        case "rb":                                          return Color(red: 0.92, green: 0.28, blue: 0.28)
        case "rs":                                          return Color(red: 0.97, green: 0.58, blue: 0.20)
        case "java", "kt":                                  return Color(red: 0.88, green: 0.54, blue: 0.20)
        case "cpp", "c", "h", "m", "mm":                   return Color(red: 0.36, green: 0.60, blue: 0.95)
        case "sql":                                         return Color(red: 0.24, green: 0.56, blue: 0.97)
        case "tf":                                          return Color(red: 0.67, green: 0.45, blue: 0.95)
        case "dockerfile":                                  return Color(red: 0.24, green: 0.56, blue: 0.97)
        case "png", "jpg", "jpeg", "gif",
             "svg", "webp", "heic", "tiff", "bmp":         return Color(red: 0.24, green: 0.78, blue: 0.78)
        case "pdf":                                         return Color(red: 0.92, green: 0.28, blue: 0.28)
        case "txt", "log":                                  return Color(.secondaryLabelColor)
        case "csv", "tsv":                                  return Color(red: 0.29, green: 0.78, blue: 0.47)
        case "xlsx", "xls", "numbers":                      return Color(red: 0.29, green: 0.78, blue: 0.47)
        case "pptx", "ppt", "key":                          return Color(red: 0.97, green: 0.58, blue: 0.20)
        case "docx", "doc", "pages":                        return Color(red: 0.24, green: 0.56, blue: 0.97)
        case "zip", "tar", "gz":                            return Color(.secondaryLabelColor)
        case "makefile":                                    return Color(red: 0.29, green: 0.78, blue: 0.47)
        default:                                            return Color(.secondaryLabelColor)
        }
    }
}
