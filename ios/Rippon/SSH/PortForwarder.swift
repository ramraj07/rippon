import Foundation
import Citadel
import NIOCore
import NIOPosix
import NIOSSH

/// Local port forwards (`ssh -L`), served on the phone's own loopback so the
/// in-app browser can open `http://localhost:<port>`.
///
/// Each accepted socket gets a `direct-tcpip` channel on the shared connection,
/// and the two are glued byte-for-byte. Listeners are bound on the SSH client's
/// own event loop so both ends of every glue live on one thread.
///
/// iOS suspends the app in the background, which takes these listeners down
/// with it; the workspace restarts them when the app comes back.
final class PortForwarder: @unchecked Sendable {
    struct Status: Equatable {
        var running: [String] = []
        var errors: [String] = []
    }

    private var servers: [Channel] = []

    func start(_ tunnels: [Tunnel], over connection: SSHConnection) async -> Status {
        await stop()
        var status = Status()
        let client = connection.client
        for t in tunnels {
            do {
                let server = try await ServerBootstrap(group: client.eventLoop)
                    .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
                    .childChannelOption(ChannelOptions.allowRemoteHalfClosure, value: true)
                    .childChannelOption(ChannelOptions.autoRead, value: false)
                    .childChannelInitializer { inbound in
                        PortForwarder.connect(inbound, to: t, via: client)
                    }
                    .bind(host: "127.0.0.1", port: t.localPort)
                    .get()
                servers.append(server)
                status.running.append(t.label)
            } catch {
                status.errors.append("\(t.label): \(describe(error))")
            }
        }
        if !status.running.isEmpty {
            ActivityLog.log("tunnel", .ok, "forwarding \(status.running.joined(separator: ", "))")
        }
        for e in status.errors { ActivityLog.log("tunnel", .error, "could not forward", detail: e) }
        return status
    }

    func stop() async {
        let old = servers
        servers = []
        for s in old { try? await s.close() }
    }

    private static func connect(_ inbound: Channel, to t: Tunnel, via client: SSHClient) -> EventLoopFuture<Void> {
        let (local, remote) = GlueHandler.matchedPair()
        // The local half goes in first, so nothing the remote end sends early has
        // nowhere to land. The remote half is opened once the socket is active,
        // and reading starts only when both halves exist.
        return inbound.pipeline.addHandlers([local, OpenRemoteOnActive { channel in
            let origin = channel.remoteAddress ?? (try? SocketAddress(ipAddress: "127.0.0.1", port: 0))
            Task {
                do {
                    guard let origin else { throw RemoteError(label: "forward", message: "no peer address") }
                    _ = try await client.createDirectTCPIPChannel(
                        using: SSHChannelType.DirectTCPIP(
                            targetHost: t.remoteHost.isEmpty ? "localhost" : t.remoteHost,
                            targetPort: t.remotePort,
                            originatorAddress: origin)
                    ) { ssh in
                        ssh.pipeline.addHandler(remote)
                    }
                    channel.read()
                } catch {
                    ActivityLog.log("tunnel", .warn, "connection to \(t.label) failed", detail: describe(error))
                    channel.close(promise: nil)
                }
            }
        }])
    }
}

/// Fires once when the accepted socket becomes active.
private final class OpenRemoteOnActive: ChannelInboundHandler {
    typealias InboundIn = ByteBuffer
    private let body: (Channel) -> Void
    init(_ body: @escaping (Channel) -> Void) { self.body = body }

    func channelActive(context: ChannelHandlerContext) {
        body(context.channel)
        context.fireChannelActive()
    }
}

/// Copies bytes between two channels on the same event loop, with backpressure
/// and half-close — the GlueHandler from swift-nio's connect-proxy example.
final class GlueHandler: ChannelDuplexHandler {
    typealias InboundIn = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = ByteBuffer

    private var partner: GlueHandler?
    private var context: ChannelHandlerContext?
    private var pendingRead = false

    static func matchedPair() -> (GlueHandler, GlueHandler) {
        let a = GlueHandler(), b = GlueHandler()
        a.partner = b
        b.partner = a
        return (a, b)
    }

    func handlerAdded(context: ChannelHandlerContext) { self.context = context }

    func handlerRemoved(context: ChannelHandlerContext) {
        self.context = nil
        partner = nil
    }

    private func partnerWrite(_ data: NIOAny) { context?.write(data, promise: nil) }
    private func partnerFlush() { context?.flush() }
    private func partnerWriteEOF() { context?.close(mode: .output, promise: nil) }
    private func partnerCloseFull() { context?.close(promise: nil) }
    private var partnerWritable: Bool { context?.channel.isWritable ?? false }

    private func partnerBecameWritable() {
        if pendingRead {
            pendingRead = false
            context?.read()
        }
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) { partner?.partnerWrite(data) }
    func channelReadComplete(context: ChannelHandlerContext) { partner?.partnerFlush() }
    func channelInactive(context: ChannelHandlerContext) { partner?.partnerCloseFull() }
    func errorCaught(context: ChannelHandlerContext, error: Error) { partner?.partnerCloseFull() }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if let e = event as? ChannelEvent, case .inputClosed = e { partner?.partnerWriteEOF() }
        context.fireUserInboundEventTriggered(event)
    }

    func channelWritabilityChanged(context: ChannelHandlerContext) {
        if context.channel.isWritable { partner?.partnerBecameWritable() }
    }

    func read(context: ChannelHandlerContext) {
        if let partner, partner.partnerWritable { context.read() } else { pendingRead = true }
    }
}
