import Cocoa
import WebKit

// =============================================================================
// MARK: - Notch Geometry
// =============================================================================

struct NotchGeometry {
    let screenFrame: NSRect
    let notchWidth: CGFloat
    let notchHeight: CGFloat
    let centerX: CGFloat
    let topY: CGFloat
    let hasPhysicalNotch: Bool

    static func detect(screen: NSScreen) -> NotchGeometry {
        let frame = screen.frame
        let topInset = screen.safeAreaInsets.top
        let hasNotch = topInset > 0
        return NotchGeometry(
            screenFrame: frame,
            notchWidth: hasNotch ? 180 : 200,
            notchHeight: hasNotch ? topInset : 32,
            centerX: frame.midX,
            topY: frame.maxY,
            hasPhysicalNotch: hasNotch
        )
    }
}

// =============================================================================
// MARK: - Island Panel (borderless floating NSPanel)
// =============================================================================

class IslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    init(geo: NotchGeometry) {
        let panelW: CGFloat = 700
        let panelH: CGFloat = 420
        let x = geo.centerX - panelW / 2
        let y = geo.topY - panelH

        super.init(
            contentRect: NSRect(x: x, y: y, width: panelW, height: panelH),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )

        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 3)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        ignoresMouseEvents = true
        isMovable = false
    }
}

// =============================================================================
// MARK: - Island View (Core Animation based)
// =============================================================================

class IslandView: NSView {
    enum Status { case collapsed, warming, expanded }
    var status: Status = .collapsed

    // Behavioral signals fed from WebSocket via the web UI
    var currentPhase: String = "idle"
    var progressSignal: String? = nil
    var activeToolName: String? = nil
    var activeToolDetail: String? = nil
    var activeFileCount: Int = 0
    var sessionCount: Int = 0
    var tokenCount: Int = 0
    var errorCount: Int = 0
    var thinkingActive: Bool = false
    var waitingForConfirmation: Bool = false
    var waitingTool: String? = nil
    var yourTurnActive: Bool = false
    var sessionDots: [(status: String, label: String)] = []
    var userQuery: String? = nil
    var recentTools: [String] = []
    var activeFile: String? = nil
    var elapsedSeconds: Int = 0

    let geo: NotchGeometry

    // Animation state
    private var animTimer: Timer?
    private var animT: CGFloat = 0        // 0=collapsed, 1=expanded
    private var animTarget: CGFloat = 0
    private var warmT: CGFloat = 0        // 0=cold, 1=warm
    private var warmTarget: CGFloat = 0
    private var pulsePhase: CGFloat = 0

    // Mouse tracking
    private var isHovering = false
    private var hoverStartTime: TimeInterval = 0
    private var exitTimer: Timer?
    private var globalMouseMonitor: Any?
    private var localMouseMonitor: Any?

    // Pill geometry
    let pillWidth: CGFloat = 220
    let pillHeight: CGFloat = 32
    let expandedWidth: CGFloat = 380
    let expandedHeight: CGFloat = 220

    // Colors
    static let phaseColors: [String: NSColor] = [
        "exploring":     NSColor(red: 147/255, green: 51/255, blue: 234/255, alpha: 1),   // purple
        "implementing":  NSColor(red: 59/255, green: 130/255, blue: 246/255, alpha: 1),    // blue
        "debugging":     NSColor(red: 239/255, green: 68/255, blue: 68/255, alpha: 1),     // red
        "testing":       NSColor(red: 34/255, green: 197/255, blue: 94/255, alpha: 1),     // green
        "planning":      NSColor(red: 234/255, green: 179/255, blue: 8/255, alpha: 1),     // yellow
        "idle":          NSColor(white: 0.35, alpha: 1),
    ]
    static let signalColors: [String: NSColor] = [
        "approaching":  NSColor(red: 6/255, green: 182/255, blue: 212/255, alpha: 1),
        "drifting":     NSColor(red: 234/255, green: 179/255, blue: 8/255, alpha: 1),
        "stuck":        NSColor(red: 239/255, green: 68/255, blue: 68/255, alpha: 1),
        "breakthrough": NSColor(red: 59/255, green: 130/255, blue: 246/255, alpha: 1),
    ]

    init(geo: NotchGeometry) {
        self.geo = geo
        super.init(frame: .zero)
        wantsLayer = true
        layer?.drawsAsynchronously = true
        startMouseMonitors()
        startAnimTimer()
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        animTimer?.invalidate()
        if let m = globalMouseMonitor { NSEvent.removeMonitor(m) }
        if let m = localMouseMonitor { NSEvent.removeMonitor(m) }
    }

    // --- Animation timer (60fps) ---

    private func startAnimTimer() {
        animTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.current.add(animTimer!, forMode: .common)
    }

    private func tick() {
        var needsRedraw = false

        // Smooth animation interpolation
        let speed: CGFloat = 0.12
        let warmSpeed: CGFloat = 0.06

        if abs(animT - animTarget) > 0.001 {
            animT += (animTarget - animT) * speed
            needsRedraw = true
        } else {
            animT = animTarget
        }

        if abs(warmT - warmTarget) > 0.001 {
            warmT += (warmTarget - warmT) * warmSpeed
            needsRedraw = true
        } else {
            warmT = warmTarget
        }

        // Pulse for stuck/thinking/waiting states
        if progressSignal == "stuck" || thinkingActive || waitingForConfirmation || yourTurnActive {
            pulsePhase += 0.05
            needsRedraw = true
        }

        // Warming timer: after hovering 0.6s, expand
        if status == .warming {
            let elapsed = CACurrentMediaTime() - hoverStartTime
            warmTarget = min(CGFloat(elapsed / 0.6), 1.0)
            if elapsed >= 0.6 {
                expand()
            }
            needsRedraw = true
        }

        if needsRedraw {
            needsDisplay = true
        }
    }

    // --- Mouse tracking ---

    private func startMouseMonitors() {
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.checkMouse()
        }
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.checkMouse()
            return event
        }
    }

    private func checkMouse() {
        guard let window = self.window else { return }
        let screenPoint = NSEvent.mouseLocation
        let windowPoint = window.convertPoint(fromScreen: screenPoint)
        let viewPoint = self.convert(windowPoint, from: nil)

        let hitRect = pillRect().insetBy(dx: -15, dy: -10)
        let isInside = hitRect.contains(viewPoint)

        if isInside && !isHovering {
            isHovering = true
            exitTimer?.invalidate()
            exitTimer = nil
            startWarming()
        } else if !isInside && isHovering {
            if exitTimer == nil {
                exitTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] _ in
                    self?.mouseExited()
                }
            }
        }
    }

    private func mouseExited() {
        isHovering = false
        exitTimer = nil
        if status == .warming {
            status = .collapsed
            warmTarget = 0
        } else if status == .expanded {
            collapse()
        }
    }

    private func startWarming() {
        guard status == .collapsed else { return }
        status = .warming
        hoverStartTime = CACurrentMediaTime()
        warmTarget = 0
    }

    func expand() {
        status = .expanded
        warmT = 1.0
        warmTarget = 1.0
        animTarget = 1.0
        (window as? IslandPanel)?.ignoresMouseEvents = false
        (window as? IslandPanel)?.hasShadow = true
    }

    func collapse() {
        status = .collapsed
        animTarget = 0
        warmTarget = 0
        (window as? IslandPanel)?.ignoresMouseEvents = true
        (window as? IslandPanel)?.hasShadow = false
    }

    // --- Hit testing ---

    override func hitTest(_ point: NSPoint) -> NSView? {
        if pillRect().contains(point) { return super.hitTest(point) }
        return nil
    }

    private func pillRect() -> NSRect {
        let t = animT
        let wGrow = warmT * 30
        let hGrow = warmT * 4
        let w = pillWidth + wGrow + (expandedWidth - pillWidth - wGrow) * t
        let h = pillHeight + hGrow + (expandedHeight - pillHeight - hGrow) * t
        let x = bounds.midX - w / 2
        let y = bounds.maxY - geo.notchHeight - 4 - h
        return NSRect(x: x, y: y, width: w, height: h)
    }

    // --- Drawing ---

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.clear(bounds)

        let t = animT
        let rect = pillRect()
        let cr: CGFloat = 16 + 4 * t  // corner radius

        let path = CGPath(roundedRect: rect, cornerWidth: cr, cornerHeight: cr, transform: nil)

        // Background
        let bgBrightness: CGFloat = 0.05 + warmT * 0.07
        ctx.addPath(path)
        ctx.setFillColor(NSColor(white: bgBrightness, alpha: 1.0).cgColor)
        ctx.fillPath()

        // Warm glow border
        if warmT > 0.05 && t < 0.1 {
            let glowColor = phaseColor().withAlphaComponent(Double(warmT * 0.5))
            ctx.addPath(path)
            ctx.setStrokeColor(glowColor.cgColor)
            ctx.setLineWidth(1.5)
            ctx.strokePath()
        }

        // Shadow when expanded
        if t > 0.1 {
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: -3), blur: 12, color: NSColor.black.withAlphaComponent(0.5).cgColor)
            ctx.addPath(path)
            ctx.setFillColor(NSColor(white: bgBrightness, alpha: 1.0).cgColor)
            ctx.fillPath()
            ctx.restoreGState()
        }

        // Clip all content to pill bounds
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()

        // Content
        if t < 0.5 {
            drawCollapsed(in: rect, ctx: ctx, alpha: 1 - t * 2)
        }
        if t > 0.3 {
            drawExpanded(in: rect, ctx: ctx, alpha: (t - 0.3) / 0.7)
        }

        ctx.restoreGState()
    }

    private func phaseColor() -> NSColor {
        if let signal = progressSignal, let c = IslandView.signalColors[signal] { return c }
        return IslandView.phaseColors[currentPhase] ?? IslandView.phaseColors["idle"]!
    }

    private let waitingColor = NSColor(red: 251/255, green: 191/255, blue: 36/255, alpha: 1)  // amber

    static let dotStatusColors: [String: NSColor] = [
        "working":  NSColor(red: 59/255, green: 130/255, blue: 246/255, alpha: 1),   // blue
        "thinking": NSColor(red: 147/255, green: 51/255, blue: 234/255, alpha: 1),   // purple
        "waiting":  NSColor(red: 251/255, green: 191/255, blue: 36/255, alpha: 1),   // amber
        "yourTurn": NSColor(red: 34/255, green: 197/255, blue: 94/255, alpha: 1),    // green
        "stuck":    NSColor(red: 239/255, green: 68/255, blue: 68/255, alpha: 1),    // red
    ]

    private func drawCollapsed(in rect: NSRect, ctx: CGContext, alpha: CGFloat) {
        let midY = rect.midY
        let dotR: CGFloat = 5
        var cursorX = rect.minX + 16

        // Draw session dots (one per session)
        let dots = sessionDots.isEmpty
            ? [(status: yourTurnActive ? "yourTurn" : (waitingForConfirmation ? "waiting" : (thinkingActive ? "thinking" : "working")), label: "")]
            : sessionDots

        for (i, dot) in dots.enumerated() {
            let dotColor = IslandView.dotStatusColors[dot.status] ?? IslandView.dotStatusColors["working"]!
            let needsPulse = dot.status == "waiting" || dot.status == "stuck"
            let pulse: CGFloat = needsPulse ? (0.6 + 0.4 * CGFloat(sin(Double(pulsePhase) * 2 + Double(i) * 0.5))) : 1.0

            ctx.setFillColor(dotColor.withAlphaComponent(Double(alpha * pulse)).cgColor)
            ctx.fillEllipse(in: CGRect(x: cursorX - dotR, y: midY - dotR, width: dotR * 2, height: dotR * 2))

            // Glow ring for waiting only (not yourTurn)
            if dot.status == "waiting" {
                let ringR = dotR + 2.5 * pulse
                ctx.setStrokeColor(dotColor.withAlphaComponent(Double(alpha * pulse * 0.3)).cgColor)
                ctx.setLineWidth(1.0)
                ctx.strokeEllipse(in: CGRect(x: cursorX - ringR, y: midY - ringR, width: ringR * 2, height: ringR * 2))
            }

            cursorX += dotR * 2 + 6
        }

        cursorX += 4

        // Status label — derived from most active session's state
        let label: String
        let labelColor: NSColor
        if yourTurnActive && !waitingForConfirmation {
            label = "your turn"
            labelColor = IslandView.dotStatusColors["yourTurn"]!
        } else if waitingForConfirmation {
            label = waitingTool != nil ? "approve \(waitingTool!)" : "awaiting approval"
            labelColor = waitingColor
        } else {
            label = thinkingActive ? "thinking" : currentPhase
            labelColor = NSColor(white: 0.85, alpha: 1)
        }

        let labelAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
            .foregroundColor: labelColor.withAlphaComponent(Double(alpha))
        ]
        let labelStr = NSAttributedString(string: label, attributes: labelAttrs)
        labelStr.draw(at: NSPoint(x: cursorX, y: midY - 7))

        // Right side: tool name + brief detail (must not overlap phase label)
        if let tool = activeToolName, !yourTurnActive, !waitingForConfirmation {
            var rightText = tool
            if let detail = activeToolDetail, !detail.isEmpty {
                rightText = "\(tool) \(detail)"
            }
            let labelEndX = cursorX + labelStr.size().width + 12
            let availW = rect.maxX - 14 - labelEndX
            guard availW > 30 else { return }  // too narrow, skip

            let toolAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
                .foregroundColor: NSColor(white: 0.5, alpha: Double(alpha))
            ]
            var display = rightText
            while NSAttributedString(string: display, attributes: toolAttrs).size().width > availW && display.count > 5 {
                display = String(display.dropLast(2)) + "…"
            }
            let toolStr = NSAttributedString(string: display, attributes: toolAttrs)
            let drawX = rect.maxX - 14 - toolStr.size().width
            toolStr.draw(at: NSPoint(x: drawX, y: midY - 6))
        }
    }

    private func drawExpanded(in rect: NSRect, ctx: CGContext, alpha: CGFloat) {
        let textColor = NSColor(white: 0.85, alpha: Double(alpha))
        let dimColor = NSColor(white: 0.45, alpha: Double(alpha))
        let faintColor = NSColor(white: 0.3, alpha: Double(alpha))
        let pad: CGFloat = 20
        var y = rect.maxY - 28

        // --- Header row: phase + elapsed time ---
        let phaseLabel = thinkingActive ? "thinking" : currentPhase
        let headerAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: phaseColor().withAlphaComponent(Double(alpha))
        ]
        NSAttributedString(string: phaseLabel, attributes: headerAttrs)
            .draw(at: NSPoint(x: rect.minX + pad, y: y))

        // Elapsed time (right-aligned)
        if elapsedSeconds > 0 {
            let mins = elapsedSeconds / 60
            let secs = elapsedSeconds % 60
            let timeStr = mins > 0 ? "\(mins)m \(secs)s" : "\(secs)s"
            let timeAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
                .foregroundColor: dimColor
            ]
            let ts = NSAttributedString(string: timeStr, attributes: timeAttrs)
            ts.draw(at: NSPoint(x: rect.maxX - pad - ts.size().width, y: y + 2))
        }

        // Signal badge (if stuck/drifting)
        if let signal = progressSignal {
            let sigColor = IslandView.signalColors[signal] ?? textColor
            let sigAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .bold),
                .foregroundColor: sigColor.withAlphaComponent(Double(alpha))
            ]
            let sigStr = NSAttributedString(string: " · \(signal.uppercased())", attributes: sigAttrs)
            let phaseStr = NSAttributedString(string: phaseLabel, attributes: headerAttrs)
            sigStr.draw(at: NSPoint(x: rect.minX + pad + phaseStr.size().width, y: y + 1))
        }

        y -= 22

        // --- Waiting banner ---
        if waitingForConfirmation {
            let bannerH: CGFloat = 22
            let bannerRect = CGRect(x: rect.minX + pad - 4, y: y - 4, width: rect.width - 2 * pad + 8, height: bannerH)
            let bannerPath = CGPath(roundedRect: bannerRect, cornerWidth: 6, cornerHeight: 6, transform: nil)
            let pulse = 0.7 + 0.3 * CGFloat(sin(Double(pulsePhase) * 2))
            ctx.setFillColor(waitingColor.withAlphaComponent(Double(alpha) * 0.15 * Double(pulse)).cgColor)
            ctx.addPath(bannerPath)
            ctx.fillPath()

            let waitText = waitingTool != nil ? "⚠ Approve \(waitingTool!) to continue" : "⚠ Awaiting approval"
            let waitAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: waitingColor.withAlphaComponent(Double(alpha))
            ]
            NSAttributedString(string: waitText, attributes: waitAttrs)
                .draw(at: NSPoint(x: rect.minX + pad + 4, y: y))
            y -= 28
        }

        // --- User query (what the agent is working on) ---
        if let query = userQuery, !query.isEmpty {
            let qAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
                .foregroundColor: NSColor(white: 0.65, alpha: Double(alpha))
            ]
            let truncated = query.count > 60 ? String(query.prefix(57)) + "..." : query
            NSAttributedString(string: "❯ \(truncated)", attributes: qAttrs)
                .draw(at: NSPoint(x: rect.minX + pad, y: y))
            y -= 18
        }

        y -= 4

        // --- Stats row ---
        let statsAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
            .foregroundColor: dimColor
        ]
        var stats: [String] = []
        if activeFileCount > 0 { stats.append("\(activeFileCount) files") }
        if tokenCount > 0 { stats.append("\(formatTokens(tokenCount)) tokens") }
        if sessionCount > 1 { stats.append("\(sessionCount) sessions") }
        if errorCount > 0 { stats.append("\(errorCount) errors") }
        if !stats.isEmpty {
            NSAttributedString(string: stats.joined(separator: "  ·  "), attributes: statsAttrs)
                .draw(at: NSPoint(x: rect.minX + pad, y: y))
        }
        y -= 20

        // --- Separator ---
        ctx.setStrokeColor(NSColor(white: 0.2, alpha: Double(alpha)).cgColor)
        ctx.setLineWidth(0.5)
        ctx.move(to: CGPoint(x: rect.minX + pad, y: y))
        ctx.addLine(to: CGPoint(x: rect.maxX - pad, y: y))
        ctx.strokePath()
        y -= 14

        // --- Recent tool activity ---
        let toolHeaderAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
            .foregroundColor: faintColor
        ]
        NSAttributedString(string: "RECENT", attributes: toolHeaderAttrs)
            .draw(at: NSPoint(x: rect.minX + pad, y: y))
        y -= 16

        let toolsToShow = recentTools.suffix(4)
        for (i, toolStr) in toolsToShow.enumerated().reversed() {
            let isCurrent = i == toolsToShow.count - 1
            let prefix = isCurrent ? "▸ " : "  "
            let lineAlpha = isCurrent ? alpha : alpha * 0.7
            let lineAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: isCurrent ? .medium : .regular),
                .foregroundColor: (isCurrent ? textColor : dimColor).withAlphaComponent(Double(lineAlpha))
            ]
            let truncTool = toolStr.count > 50 ? String(toolStr.prefix(47)) + "..." : toolStr
            NSAttributedString(string: "\(prefix)\(truncTool)", attributes: lineAttrs)
                .draw(at: NSPoint(x: rect.minX + pad, y: y))
            y -= 15
            if y < rect.minY + 35 { break }
        }

        // --- Bottom hint ---
        let hintY = rect.minY + 12
        let hintAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .regular),
            .foregroundColor: NSColor(white: 0.25, alpha: Double(alpha))
        ]
        NSAttributedString(string: "⌘⇧I toggle  ·  ⌘⇧L window", attributes: hintAttrs)
            .draw(at: NSPoint(x: rect.minX + pad, y: hintY))
    }

    private func phaseFill() -> CGFloat {
        switch currentPhase {
        case "exploring": return 0.2
        case "planning": return 0.3
        case "implementing": return 0.6
        case "testing": return 0.8
        case "debugging": return 0.5
        default: return 0.0
        }
    }

    private func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }

    // --- Public signal update ---

    func updateSignals(phase: String, progress: String?, tool: String?, toolDetail: String?, files: Int, sessions: Int, tokens: Int, errors: Int, thinking: Bool, waiting: Bool, waitingTool: String?, yourTurn: Bool, userQuery: String?, recentTools: [String], activeFile: String?, elapsed: Int, sessionDots: [(status: String, label: String)]) {
        currentPhase = phase
        progressSignal = progress
        activeToolName = tool
        activeToolDetail = toolDetail
        activeFileCount = files
        sessionCount = sessions
        tokenCount = tokens
        errorCount = errors
        thinkingActive = thinking
        waitingForConfirmation = waiting
        self.waitingTool = waitingTool
        self.yourTurnActive = yourTurn
        self.sessionDots = sessionDots
        self.userQuery = userQuery
        self.recentTools = recentTools
        self.activeFile = activeFile
        self.elapsedSeconds = elapsed
        needsDisplay = true
    }
}

// =============================================================================
// MARK: - Island Controller
// =============================================================================

class IslandController {
    var panel: IslandPanel?
    var islandView: IslandView?

    // Cached signals so we can restore state after toggle
    private var lastSignals: (phase: String, progress: String?, tool: String?, toolDetail: String?, files: Int, sessions: Int, tokens: Int, errors: Int, thinking: Bool, waiting: Bool, waitingTool: String?, yourTurn: Bool, userQuery: String?, recentTools: [String], activeFile: String?, elapsed: Int, sessionDots: [(status: String, label: String)])?

    func setup(screen: NSScreen) {
        teardown()
        let geo = NotchGeometry.detect(screen: screen)
        let panel = IslandPanel(geo: geo)
        let view = IslandView(geo: geo)

        let contentRect = panel.contentRect(forFrameRect: panel.frame)
        view.frame = NSRect(origin: .zero, size: contentRect.size)
        view.autoresizingMask = [.width, .height]
        panel.contentView = view

        self.panel = panel
        self.islandView = view

        // Restore last known state
        if let s = lastSignals {
            view.updateSignals(phase: s.phase, progress: s.progress, tool: s.tool, toolDetail: s.toolDetail, files: s.files, sessions: s.sessions, tokens: s.tokens, errors: s.errors, thinking: s.thinking, waiting: s.waiting, waitingTool: s.waitingTool, yourTurn: s.yourTurn, userQuery: s.userQuery, recentTools: s.recentTools, activeFile: s.activeFile, elapsed: s.elapsed, sessionDots: s.sessionDots)
        }
    }

    func show() { panel?.orderFrontRegardless() }
    func hide() { panel?.orderOut(nil) }

    func teardown() {
        panel?.orderOut(nil)
        panel = nil
        islandView = nil
    }

    func updateSignals(phase: String, progress: String?, tool: String?, toolDetail: String?, files: Int, sessions: Int, tokens: Int, errors: Int, thinking: Bool, waiting: Bool, waitingTool: String?, yourTurn: Bool, userQuery: String?, recentTools: [String], activeFile: String?, elapsed: Int, sessionDots: [(status: String, label: String)]) {
        lastSignals = (phase, progress, tool, toolDetail, files, sessions, tokens, errors, thinking, waiting, waitingTool, yourTurn, userQuery, recentTools, activeFile, elapsed, sessionDots)
        islandView?.updateSignals(phase: phase, progress: progress, tool: tool, toolDetail: toolDetail, files: files, sessions: sessions, tokens: tokens, errors: errors, thinking: thinking, waiting: waiting, waitingTool: waitingTool, yourTurn: yourTurn, userQuery: userQuery, recentTools: recentTools, activeFile: activeFile, elapsed: elapsed, sessionDots: sessionDots)
    }
}

// =============================================================================
// MARK: - App Delegate
// =============================================================================

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var currentTheme = "dark"
    var isCompact = true
    var retryCount = 0
    let maxRetries = 60
    var port: String = "8390"
    var retryTimer: Timer?
    var hasPositionedWindow = false
    var autoHideEnabled = false
    var autoHideObserver: Any?
    var autoHideSuppressed = false

    // Island
    let island = IslandController()
    var islandEnabled = true

    // Saved frames for switching between compact/full
    let compactSize = NSSize(width: 420, height: 600)
    let fullSize = NSSize(width: 560, height: 0) // height computed from screen

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "themeChange", let theme = message.body as? String {
            guard theme != currentTheme else { return }
            currentTheme = theme
            let appearance = theme == "light" ? NSAppearance(named: .aqua) : NSAppearance(named: .darkAqua)
            let bgColor = theme == "light"
                ? NSColor(red: 248.0/255, green: 250.0/255, blue: 252.0/255, alpha: 1.0)
                : NSColor(red: 15.0/255, green: 23.0/255, blue: 42.0/255, alpha: 1.0)
            window.appearance = appearance
            window.backgroundColor = bgColor
        }
        if message.name == "autoHide", let enabled = message.body as? Bool {
            autoHideEnabled = enabled
            if enabled {
                if autoHideObserver == nil {
                    autoHideObserver = NotificationCenter.default.addObserver(
                        forName: NSWindow.didResignKeyNotification, object: window, queue: .main
                    ) { [weak self] _ in
                        guard let self = self, !self.autoHideSuppressed else { return }
                        self.window.orderOut(nil)
                    }
                }
            } else {
                if let obs = autoHideObserver {
                    NotificationCenter.default.removeObserver(obs)
                    autoHideObserver = nil
                }
            }
        }
        if message.name == "switchMode", let mode = message.body as? String {
            if mode == "window" {
                switchToFull()
            } else {
                switchToCompact()
            }
        }

        // Island signal updates from web UI
        if message.name == "islandUpdate", let data = message.body as? [String: Any] {
            island.updateSignals(
                phase: data["phase"] as? String ?? "idle",
                progress: data["progress"] as? String,
                tool: data["tool"] as? String,
                toolDetail: data["toolDetail"] as? String,
                files: data["files"] as? Int ?? 0,
                sessions: data["sessions"] as? Int ?? 0,
                tokens: data["tokens"] as? Int ?? 0,
                errors: data["errors"] as? Int ?? 0,
                thinking: data["thinking"] as? Bool ?? false,
                waiting: data["waiting"] as? Bool ?? false,
                waitingTool: data["waitingTool"] as? String,
                yourTurn: data["yourTurn"] as? Bool ?? false,
                userQuery: data["userQuery"] as? String,
                recentTools: data["recentTools"] as? [String] ?? [],
                activeFile: data["activeFile"] as? String,
                elapsed: data["elapsed"] as? Int ?? 0,
                sessionDots: (data["sessionDots"] as? [[String: String]])?.map { d in
                    (status: d["status"] ?? "working", label: d["label"] ?? "")
                } ?? []
            )
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        port = ProcessInfo.processInfo.environment["LOUPE_PORT"] ?? "8390"

        // Global hotkeys
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.modifierFlags.contains([.command, .shift]) else { return }
            if event.keyCode == 37 { self?.toggleWindow() }       // Cmd+Shift+L
            if event.keyCode == 34 { self?.toggleIsland() }       // Cmd+Shift+I
        }

        // Create single window
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: compactSize.width, height: compactSize.height),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Loupe"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.level = .floating
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 15.0/255, green: 23.0/255, blue: 42.0/255, alpha: 1.0)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 320, height: 300)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.hasShadow = true
        window.setFrameAutosaveName("loupe-compact")

        // Single webview
        webView = makeWebView()
        if let cv = window.contentView {
            cv.addSubview(webView)
            webView.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                webView.topAnchor.constraint(equalTo: cv.topAnchor),
                webView.bottomAnchor.constraint(equalTo: cv.bottomAnchor),
                webView.leadingAnchor.constraint(equalTo: cv.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: cv.trailingAnchor),
            ])
        }

        // Intercept Cmd+/- for zoom, Cmd+Shift+/- for columns, Cmd+Shift+L for toggle
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.modifierFlags.contains(.command) else { return event }
            if event.modifierFlags.contains(.shift) && event.keyCode == 37 { // Cmd+Shift+L
                self?.toggleWindow()
                return nil
            }
            if event.modifierFlags.contains(.shift) && event.keyCode == 4 { // Cmd+Shift+H
                self?.webView.evaluateJavaScript("toggleAutoHide()", completionHandler: nil)
                return nil
            }
            if event.modifierFlags.contains(.shift) && event.keyCode == 46 { // Cmd+Shift+M
                if self?.isCompact == true {
                    self?.switchToFull()
                } else {
                    self?.switchToCompact()
                }
                return nil
            }
            if event.modifierFlags.contains(.shift) && event.keyCode == 34 { // Cmd+Shift+I
                self?.toggleIsland()
                return nil
            }
            let wv = self?.webView
            let hasShift = event.modifierFlags.contains(.shift)
            if event.keyCode == 24 {  // =/+ key
                if hasShift {
                    wv?.evaluateJavaScript("if(typeof gravityView!=='undefined'&&gravityView){if(typeof gravityDim!=='undefined'&&gravityDim==='3d'){Gravity3D.zoom(1.2)}else{Gravity.zoom(1.2)}}else{setGridCols(gridCols+1)}", completionHandler: nil)
                } else {
                    wv?.evaluateJavaScript("adjustFontSize(1)", completionHandler: nil)
                }
                return nil
            }
            if event.keyCode == 27 {  // -/_ key
                if hasShift {
                    wv?.evaluateJavaScript("if(typeof gravityView!=='undefined'&&gravityView){if(typeof gravityDim!=='undefined'&&gravityDim==='3d'){Gravity3D.zoom(0.8)}else{Gravity.zoom(0.8)}}else{setGridCols(gridCols-1)}", completionHandler: nil)
                } else {
                    wv?.evaluateJavaScript("adjustFontSize(-1)", completionHandler: nil)
                }
                return nil
            }
            return event
        }

        // Window always stays fully opaque (no fade on blur)

        // Force compact size on launch (autosave may have restored a different size)
        let currentOrigin = window.frame.origin
        window.setFrame(NSRect(origin: currentOrigin, size: compactSize), display: false)

        // Load page in compact (minimal) mode and show
        loadPage()
        positionWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Launch island
        if islandEnabled, let screen = NSScreen.main {
            island.setup(screen: screen)
            island.show()
        }

        // Re-create island if display configuration changes
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, self.islandEnabled, let screen = NSScreen.main else { return }
            self.island.setup(screen: screen)
            self.island.show()
        }
    }

    func toggleIsland() {
        islandEnabled.toggle()
        if islandEnabled {
            if let screen = NSScreen.main {
                island.setup(screen: screen)
                island.show()
            }
        } else {
            island.teardown()
        }
    }

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController.add(self, name: "themeChange")
        config.userContentController.add(self, name: "switchMode")
        config.userContentController.add(self, name: "autoHide")
        config.userContentController.add(self, name: "islandUpdate")
        config.websiteDataStore = WKWebsiteDataStore.default()

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.setValue(false, forKey: "drawsBackground")
        wv.allowsMagnification = false
        return wv
    }

    func showWindow() {
        autoHideSuppressed = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // Re-enable auto-hide after window is settled
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.autoHideSuppressed = false
        }
    }

    func toggleWindow() {
        if window.isVisible {
            window.orderOut(nil)
        } else {
            showWindow()
        }
    }

    func positionWindow() {
        if hasPositionedWindow { return }
        hasPositionedWindow = true
        guard let screen = NSScreen.main else { return }
        let visibleFrame = screen.visibleFrame
        let winSize = window.frame.size
        let x = visibleFrame.minX + (visibleFrame.width - winSize.width) / 2 - visibleFrame.width * 0.1
        let y = visibleFrame.minY + (visibleFrame.height - winSize.height) / 2
        window.setFrameOrigin(NSPoint(x: x, y: y))
    }

    func switchToFull() {
        isCompact = false
        // Toggle UI via JS (no reload)
        webView.evaluateJavaScript("document.body.classList.remove('minimal')", completionHandler: nil)
        // Resize window
        guard let screen = NSScreen.main else { return }
        let visibleFrame = screen.visibleFrame
        let height = visibleFrame.height * 0.85
        let currentFrame = window.frame
        let newWidth = fullSize.width
        // Keep top-left anchored
        let newOrigin = NSPoint(x: currentFrame.origin.x, y: currentFrame.maxY - height)
        window.setFrame(NSRect(origin: newOrigin, size: NSSize(width: newWidth, height: height)), display: true, animate: true)
    }

    func switchToCompact() {
        isCompact = true
        // Toggle UI via JS (no reload)
        webView.evaluateJavaScript("document.body.classList.add('minimal')", completionHandler: nil)
        // Resize window
        let currentFrame = window.frame
        // Keep top-left anchored
        let newOrigin = NSPoint(x: currentFrame.origin.x, y: currentFrame.maxY - compactSize.height)
        window.setFrame(NSRect(origin: newOrigin, size: compactSize), display: true, animate: true)
    }

    func loadPage() {
        let mode = isCompact ? "?mode=minimal" : ""
        let url = URL(string: "http://localhost:\(port)\(mode)")!
        NSLog("loupe: loading \(url) (attempt \(retryCount + 1))")
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    // Navigation succeeded
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("loupe: page loaded successfully")
        retryCount = 0
        retryTimer?.invalidate()
        retryTimer = nil
    }

    // Navigation failed — schedule retry
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("loupe: load failed: \(error.localizedDescription)")
        scheduleRetry()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("loupe: navigation error: \(error.localizedDescription)")
        scheduleRetry()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        if challenge.protectionSpace.host == "localhost" {
            return (.useCredential, URLCredential(trust: challenge.protectionSpace.serverTrust!))
        }
        return (.performDefaultHandling, nil)
    }

    func scheduleRetry() {
        retryCount += 1
        if retryCount <= maxRetries {
            let delay = min(Double(retryCount) * 0.5, 3.0)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.loadPage()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag || !window.isVisible {
            showWindow()
        }
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // Dock click when window is hidden — bring it back
        if !window.isVisible {
            showWindow()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        island.teardown()
        if let pidStr = ProcessInfo.processInfo.environment["LOGSTREAM_SERVER_PID"],
           let pid = Int32(pidStr) {
            kill(pid, SIGTERM)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
