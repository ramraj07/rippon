import SwiftUI

@main
struct RipponApp: App {
    @StateObject private var hosts: HostStore
    @StateObject private var keys = KeyStore()
    @StateObject private var workspace: Workspace
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let store = HostStore()
        _hosts = StateObject(wrappedValue: store)
        _workspace = StateObject(wrappedValue: Workspace(hosts: store))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(hosts)
                .environmentObject(keys)
                .environmentObject(workspace)
                .environmentObject(ActivityLog.shared)
                .tint(.accentColor)
                .onAppear { workspace.start() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { workspace.becameActive() }
        }
    }
}
