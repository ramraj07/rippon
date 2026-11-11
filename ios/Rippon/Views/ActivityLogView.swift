import SwiftUI

struct ActivityLogView: View {
    @EnvironmentObject var log: ActivityLog
    @Environment(\.dismiss) private var dismiss
    @State private var expanded: Set<Int> = []

    var body: some View {
        List {
            ForEach(log.entries.reversed()) { e in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Circle().fill(color(e.level)).frame(width: 7, height: 7)
                        Text(e.source).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        Text(e.text).font(.caption).lineLimit(expanded.contains(e.id) ? nil : 2)
                        Spacer(minLength: 4)
                        if e.count > 1 { Text("×\(e.count)").font(.caption2).foregroundStyle(.secondary) }
                        if let ms = e.ms { Text("\(ms)ms").font(.caption2.monospaced()).foregroundStyle(.secondary) }
                    }
                    if expanded.contains(e.id), let d = e.detail {
                        Text(d).font(.caption2.monospaced()).textSelection(.enabled).foregroundStyle(.secondary)
                    }
                    Text(e.at, style: .time).font(.caption2).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    if expanded.contains(e.id) { expanded.remove(e.id) } else { expanded.insert(e.id) }
                }
            }
        }
        .listStyle(.plain)
        .overlay { if log.entries.isEmpty { ContentUnavailableView("Nothing yet", systemImage: "list.bullet.rectangle") } }
        .navigationTitle("SSH activity")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            ToolbarItem(placement: .primaryAction) { Button("Clear") { log.clear() } }
        }
    }

    private func color(_ l: ActivityLog.Level) -> Color {
        switch l {
        case .info: return .secondary
        case .ok: return .green
        case .warn: return .orange
        case .error: return .red
        }
    }
}
