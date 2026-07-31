import SwiftUI

struct SectionChromeBar: View {
    @ObservedObject var registry = FeatureRegistry.shared
    @Binding var selectedTab: ShellTab
    
    var body: some View {
        HStack(spacing: 8) {
            if registry.isEnabled(.fileExplorer) {
                NavigationTabButton(
                    title: "Explorer",
                    icon: "folder",
                    isSelected: selectedTab == .explorer
                ) {
                    selectedTab = .explorer
                }
            }
            
            if registry.isEnabled(.agentChat) {
                NavigationTabButton(
                    title: "AI Chat",
                    icon: "bubble.left.and.bubble.right",
                    isSelected: selectedTab == .chat
                ) {
                    selectedTab = .chat
                }
            }
            
            if registry.isEnabled(.codeGraph3D) {
                NavigationTabButton(
                    title: "Code Graph",
                    icon: "cube.transparent",
                    isSelected: selectedTab == .codeGraph
                ) {
                    selectedTab = .codeGraph
                }
            }
            
            if registry.isEnabled(.ganttIssues) {
                NavigationTabButton(
                    title: "Issues & Gantt",
                    icon: "calendar.timeline.left",
                    isSelected: selectedTab == .gantt
                ) {
                    selectedTab = .gantt
                }
            }
            
            if registry.isEnabled(.terminal) {
                NavigationTabButton(
                    title: "Terminal",
                    icon: "terminal",
                    isSelected: selectedTab == .terminal
                ) {
                    selectedTab = .terminal
                }
            }
            
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(NSColor.windowBackgroundColor))
    }
}