import Cocoa
import WebKit

extension NSColor {
    static func fromHex(_ hex: String) -> NSColor {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard h.count == 6, let v = UInt64(h, radix: 16) else { return .white }
        return NSColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}

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
        // Menu bar height = difference between frame top and visible frame top
        let menuBarH = frame.maxY - screen.visibleFrame.maxY
        return NotchGeometry(
            screenFrame: frame,
            notchWidth: hasNotch ? 180 : 200,
            notchHeight: hasNotch ? topInset : max(menuBarH, 25),
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
        let panelW: CGFloat = 500
        let panelH: CGFloat = 420
        // Position to the left of the notch/camera area
        let notchLeftEdge = geo.centerX - geo.notchWidth / 2
        let x = notchLeftEdge - panelW - 8
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
    var tokIn: Int = 0
    var tokOut: Int = 0
    var tokCacheRead: Int = 0
    var tokCacheCreate: Int = 0
    var errorCount: Int = 0
    var thinkingActive: Bool = false
    var waitingForConfirmation: Bool = false
    var pulsing: Bool = false
    private var pulseCount: Int = 0
    private var wasPulsing: Bool = false
    var waitingTool: String? = nil
    var approvedTool: String? = nil
    var rejectedTool: String? = nil
    var planningStrike: Bool = false
    var idleSeconds: Int = 0
    var sessionDots: [(status: String, label: String, color: String, id: String)] = []
    var activeSessionColor: NSColor? = nil
    var activeSessionId: String? = nil
    var userQuery: String? = nil
    var recentTools: [String] = []
    var activeFile: String? = nil
    var elapsedSeconds: Int = 0
    var pinnedSessionId: String? = nil

    // Callback to send WebSocket messages (set by AppDelegate)
    var onSendWS: (([String: Any]) -> Void)?

    // Hit regions for session tabs in expanded view
    private var sessionTabRects: [(rect: NSRect, sessionId: String)] = []

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

    // Pill geometry — dynamic width
    let pillMinWidth: CGFloat = 80
    let pillMaxWidth: CGFloat = 260
    let pillHeight: CGFloat = 28
    private var pillTargetWidth: CGFloat = 160
    private var pillCurrentWidth: CGFloat = 160
    let expandedWidth: CGFloat = 380
    let expandedHeight: CGFloat = 300

    // Colors
    static let phaseColors: [String: NSColor] = [
        "exploring":     NSColor(red: 147/255, green: 51/255, blue: 234/255, alpha: 1),   // purple
        "implementing":  NSColor(red: 59/255, green: 130/255, blue: 246/255, alpha: 1),    // blue
        "debugging":     NSColor(red: 239/255, green: 68/255, blue: 68/255, alpha: 1),     // red
        "testing":       NSColor(red: 34/255, green: 197/255, blue: 94/255, alpha: 1),     // green
        "planning":      NSColor(red: 234/255, green: 179/255, blue: 8/255, alpha: 1),     // yellow
        "thinking":      NSColor(red: 234/255, green: 179/255, blue: 8/255, alpha: 1),     // yellow
        "orchestrating": NSColor(red: 6/255, green: 182/255, blue: 212/255, alpha: 1),     // cyan
        "idle":          NSColor(white: 0.35, alpha: 1),
        "starting":      NSColor(red: 59/255, green: 130/255, blue: 246/255, alpha: 1),    // blue
        "done":          NSColor(red: 34/255, green: 197/255, blue: 94/255, alpha: 1),    // green
        "waiting for input": NSColor(red: 34/255, green: 197/255, blue: 94/255, alpha: 1), // green
    ]
    static let signalColors: [String: NSColor] = [
        "approaching":  NSColor(red: 6/255, green: 182/255, blue: 212/255, alpha: 1),
        "drifting":     NSColor(red: 234/255, green: 179/255, blue: 8/255, alpha: 1),
        "stuck":        NSColor(red: 239/255, green: 68/255, blue: 68/255, alpha: 1),
        "breakthrough": NSColor(red: 59/255, green: 130/255, blue: 246/255, alpha: 1),
    ]

    // ASCII art glyphs: 2 rows per letter using half-block characters (▀▄█)
    static let asciiGlyphs: [Character: [String]] = [
        "A": ["▄▀▄", "█▀█"],
        "B": ["██▀", "██▄"],
        "C": ["▄▀▀", "▀▄▄"],
        "D": ["█▀▄", "█▄▀"],
        "E": ["██▀", "█▄▄"],
        "G": ["█▀▀", "█▄█"],
        "H": ["█▄█", "█ █"],
        "I": ["█", "█"],
        "K": ["█▄▀", "█▀▄"],
        "L": ["█  ", "█▄▄"],
        "M": ["█▄▄█", "█  █"],
        "N": ["█▄ █", "█ ▀█"],
        "O": ["▄▀▄", "▀▄▀"],
        "P": ["█▀▄", "█▀ "],
        "R": ["█▀▄", "█ ▀"],
        "S": ["▄▀▀", "▄▄▀"],
        "T": ["▀█▀", " ▀ "],
        "U": ["█ █", "▀▄▀"],
        "W": ["█ █ █", "▀▄█▄▀"],
        "X": ["▀▄▀", "▄▀▄"],
    ]

    static let phaseDisplayNames: [String: String] = [
        "idle": "IDLE",
        "exploring": "EXPLORING",
        "implementing": "IMPLEMENT",
        "debugging": "DEBUGGING",
        "testing": "TESTING",
        "planning": "PLANNING",
        "thinking": "THINKING",
        "orchestrating": "ORCHESTRATE",
        "done": "DONE",
        "starting": "STARTING",
        "waiting for input": "WAITING",
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

        // Smooth pill width animation
        if abs(pillCurrentWidth - pillTargetWidth) > 0.5 {
            pillCurrentWidth += (pillTargetWidth - pillCurrentWidth) * 0.1
            needsRedraw = true
        } else {
            pillCurrentWidth = pillTargetWidth
        }

        // Pulse counting: stop after 10 full cycles
        if pulsing && !wasPulsing {
            pulseCount = 0  // reset on new pulse start
        }
        wasPulsing = pulsing
        pulsePhase += 0.05
        if pulsing {
            // A full cycle is when sin completes a period (~63 frames at 0.05 increment)
            // Count zero-crossings going positive
            let prev = sin(Double(pulsePhase - 0.05) * 2)
            let curr = sin(Double(pulsePhase) * 2)
            if prev <= 0 && curr > 0 { pulseCount += 1 }
            if pulseCount >= 10 { pulsing = false }
        }
        needsRedraw = true

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

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        if pillRect().contains(point) { return super.hitTest(point) }
        return nil
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard status == .expanded else { return }
        for tab in sessionTabRects {
            if tab.rect.contains(point) {
                let newPin = (tab.sessionId == pinnedSessionId) ? nil : tab.sessionId
                pinnedSessionId = newPin
                onSendWS?(["type": "pin_session", "sessionId": newPin ?? NSNull()])
                needsDisplay = true
                return
            }
        }
    }

    private func pillRect() -> NSRect {
        let t = animT
        let baseW = pillCurrentWidth
        let wGrow = warmT * 30
        let hGrow = warmT * 4
        let w = baseW + wGrow + (expandedWidth - baseW - wGrow) * t
        let h = pillHeight + hGrow + (expandedHeight - pillHeight - hGrow) * t

        // Heartbeat scale when pulsing (collapsed only)
        if pulsing && t < 0.1 {
            let beat = CGFloat(sin(Double(pulsePhase) * 2))
            let scale: CGFloat = 1.0 + 0.03 * beat  // subtle 3% breathe
            let cw = w * scale
            let ch = h * scale
            let cx = bounds.maxX - w / 2 - 8
            let cy = bounds.maxY - h / 2 - 2
            return NSRect(x: cx - cw / 2, y: cy - ch / 2, width: cw, height: ch)
        }

        // Right-aligned within panel (close to notch), top of screen
        let x = bounds.maxX - w - 8
        let y = bounds.maxY - h - 2
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

        // Pill aura — aurora cycle through jewel tones (independent of session color)
        // Palette: indigo → violet → magenta → rose → sapphire → indigo
        if t < 0.1 {
            let cycle = CGFloat(pulsePhase) * 0.003  // very slow drift
            let auraStops: [(h: CGFloat, s: CGFloat, b: CGFloat)] = [
                (0.72, 0.75, 0.85),   // indigo
                (0.78, 0.65, 0.90),   // violet
                (0.85, 0.60, 0.88),   // magenta
                (0.93, 0.55, 0.85),   // rose
                (0.62, 0.70, 0.90),   // sapphire
            ]
            let count = CGFloat(auraStops.count)
            let pos = fmod(cycle, 1.0) * count
            let idx0 = Int(pos) % auraStops.count
            let idx1 = (idx0 + 1) % auraStops.count
            let frac = pos - floor(pos)
            let c0 = auraStops[idx0], c1 = auraStops[idx1]
            let h = c0.h + (c1.h - c0.h) * frac
            let s = c0.s + (c1.s - c0.s) * frac
            let b = c0.b + (c1.b - c0.b) * frac
            let auraColor = NSColor(hue: fmod(h + 1.0, 1.0), saturation: s, brightness: b, alpha: 1.0)

            ctx.saveGState()
            ctx.setShadow(offset: .zero, blur: 10, color: auraColor.withAlphaComponent(0.35).cgColor)
            ctx.addPath(path)
            ctx.setStrokeColor(auraColor.withAlphaComponent(0.45).cgColor)
            ctx.setLineWidth(1.5)
            ctx.strokePath()
            ctx.restoreGState()
        }

        // Warm glow border (overrides aura on hover)
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

    private func asciiArtForPhase() -> [String] {
        let phase = thinkingActive ? "thinking" : currentPhase
        let word = IslandView.phaseDisplayNames[phase] ?? phase.uppercased()
        var row0 = ""
        var row1 = ""
        for (i, ch) in word.enumerated() {
            if i > 0 { row0 += " "; row1 += " " }
            if let glyph = IslandView.asciiGlyphs[ch] {
                row0 += glyph[0]
                row1 += glyph[1]
            }
        }
        return [row0, row1]
    }

    private let waitingColor = NSColor(red: 251/255, green: 191/255, blue: 36/255, alpha: 1)  // amber

    static let dotStatusColors: [String: NSColor] = [
        "working":  NSColor(red: 59/255, green: 130/255, blue: 246/255, alpha: 1),   // blue
        "thinking": NSColor(red: 147/255, green: 51/255, blue: 234/255, alpha: 1),   // purple
        "waiting":  NSColor(red: 251/255, green: 191/255, blue: 36/255, alpha: 1),   // amber
        "idle":       NSColor(white: 0.35, alpha: 1),                                  // gray
        "needsInput": NSColor(red: 34/255, green: 197/255, blue: 94/255, alpha: 1),    // green
        "done":       NSColor(red: 34/255, green: 197/255, blue: 94/255, alpha: 1),    // green
        "stuck":    NSColor(red: 239/255, green: 68/255, blue: 68/255, alpha: 1),    // red
    ]

    private func drawCollapsed(in rect: NSRect, ctx: CGContext, alpha: CGFloat) {
        let midY = rect.midY
        let dotR: CGFloat = 4
        var cursorX = rect.minX + 12

        // Draw session dots (one per session)
        let dots = sessionDots.isEmpty
            ? [(status: waitingForConfirmation ? "waiting" : (thinkingActive ? "thinking" : (currentPhase == "idle" ? "idle" : "working")), label: "", color: "", id: "")]
            : sessionDots

        for (i, dot) in dots.enumerated() {
            let dotColor = IslandView.dotStatusColors[dot.status] ?? IslandView.dotStatusColors["working"]!
            let needsPulse = pulsing || dot.status == "stuck"
            let pulse: CGFloat = needsPulse ? (0.6 + 0.4 * CGFloat(sin(Double(pulsePhase) * 2 + Double(i) * 0.5))) : 1.0

            // Draw the dot
            ctx.setFillColor(dotColor.withAlphaComponent(Double(alpha * pulse)).cgColor)
            ctx.fillEllipse(in: CGRect(x: cursorX - dotR, y: midY - dotR, width: dotR * 2, height: dotR * 2))

            // Session color aura ring — pulses when this session's log is shown
            if !dot.color.isEmpty {
                let auraColor = NSColor.fromHex(dot.color)
                let isActive = !dot.id.isEmpty && dot.id == (activeSessionId ?? "")
                let ringPulse: CGFloat = isActive ? (0.4 + 0.4 * CGFloat(sin(Double(pulsePhase) * 2 + Double(i) * 0.5))) : 0.3
                let ringR = dotR + 3
                ctx.setStrokeColor(auraColor.withAlphaComponent(Double(alpha) * Double(ringPulse)).cgColor)
                ctx.setLineWidth(isActive ? 2.0 : 1.0)
                ctx.strokeEllipse(in: CGRect(x: cursorX - ringR, y: midY - ringR, width: ringR * 2, height: ringR * 2))
            }

            // Glow ring for waiting only
            if pulsing && (dot.status == "waiting" || dot.status == "done" || dot.status == "needsInput") {
                let ringR = dotR + 2.5 * pulse
                ctx.setStrokeColor(dotColor.withAlphaComponent(Double(alpha * pulse * 0.3)).cgColor)
                ctx.setLineWidth(1.0)
                ctx.strokeEllipse(in: CGRect(x: cursorX - ringR, y: midY - ringR, width: ringR * 2, height: ringR * 2))
            }

            cursorX += dotR * 2 + 6
        }

        cursorX += 4

        // Status label
        let label: String
        let labelColor: NSColor
        if let tool = rejectedTool {
            // Brief flash after rejection
            label = "rejected \(tool)"
            labelColor = NSColor(red: 239/255, green: 68/255, blue: 68/255, alpha: 1) // red
        } else if let tool = approvedTool {
            // Brief strikethrough after approval
            label = tool
            labelColor = NSColor(red: 34/255, green: 197/255, blue: 94/255, alpha: 1) // green
        } else if waitingForConfirmation {
            label = waitingTool != nil ? "approve \(waitingTool!)" : "awaiting approval"
            labelColor = waitingColor
        } else if currentPhase == "idle" {
            label = "idle"
            labelColor = NSColor(white: 0.5, alpha: 1)
        } else {
            label = thinkingActive ? "thinking" : currentPhase
            labelColor = NSColor(white: 0.85, alpha: 1)
        }

        // Compute dynamic pill width from content
        let dotsSectionWidth: CGFloat = cursorX - rect.minX  // dots already drawn up to cursorX
        let labelFont = NSFont.monospacedSystemFont(ofSize: 10, weight: .medium)
        let labelSize = (label as NSString).size(withAttributes: [.font: labelFont])
        // Also account for right-side tool text
        var rightWidth: CGFloat = 0
        if let tool = activeToolName, !waitingForConfirmation, currentPhase != "idle" {
            var rt = tool
            if let detail = activeToolDetail, !detail.isEmpty { rt = "\(tool) \(detail)" }
            let rightFont = NSFont.monospacedSystemFont(ofSize: 9, weight: .regular)
            rightWidth = (rt as NSString).size(withAttributes: [.font: rightFont]).width + 16
        }
        let contentWidth = dotsSectionWidth + labelSize.width + rightWidth + 20  // 20 = padding
        pillTargetWidth = min(pillMaxWidth, max(pillMinWidth, contentWidth))

        // Pulse the label for approval, waiting for input, and strikethrough states
        let shouldPulseLabel = pulsing
        let labelPulse: CGFloat = shouldPulseLabel ? (0.5 + 0.5 * CGFloat(sin(Double(pulsePhase) * 2))) : 1.0
        var labelAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium),
            .foregroundColor: labelColor.withAlphaComponent(Double(alpha * labelPulse))
        ]
        if approvedTool != nil {
            labelAttrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            labelAttrs[.strikethroughColor] = labelColor.withAlphaComponent(Double(alpha * labelPulse) * 0.8)
        }
        let labelStr = NSAttributedString(string: label, attributes: labelAttrs)
        labelStr.draw(at: NSPoint(x: cursorX, y: midY - 6))

        // no extra decorations after label

        // Right side: tool name + brief detail (must not overlap phase label)
        if let tool = activeToolName, !waitingForConfirmation, currentPhase != "idle" {
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

        // --- ASCII art phase + elapsed time ---
        let artLines = asciiArtForPhase()
        let artFont = NSFont.monospacedSystemFont(ofSize: 8, weight: .medium)
        let artColor = phaseColor().withAlphaComponent(Double(alpha))
        let artLineH: CGFloat = 9
        for (i, line) in artLines.enumerated() {
            let artAttrs: [NSAttributedString.Key: Any] = [
                .font: artFont,
                .foregroundColor: artColor
            ]
            NSAttributedString(string: line, attributes: artAttrs)
                .draw(at: NSPoint(x: rect.minX + pad, y: y - CGFloat(i) * artLineH))
        }

        // Planning strikethrough — dimmed "PLANNING" with line-through after current phase art
        if planningStrike {
            let strikeColor = (IslandView.phaseColors["planning"] ?? NSColor.gray).withAlphaComponent(Double(alpha) * 0.4)
            let topLineWidth = NSAttributedString(string: artLines[0], attributes: [.font: artFont]).size().width
            let strikeAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 8, weight: .medium),
                .foregroundColor: strikeColor,
                .strikethroughStyle: NSUnderlineStyle.single.rawValue,
                .strikethroughColor: strikeColor,
            ]
            NSAttributedString(string: " PLANNING", attributes: strikeAttrs)
                .draw(at: NSPoint(x: rect.minX + pad + topLineWidth + 4, y: y - artLineH + 2))
        }

        // Elapsed time (right-aligned, top row)
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

        // Signal badge (after art top row)
        if let signal = progressSignal {
            let sigColor = IslandView.signalColors[signal] ?? textColor
            let sigAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .bold),
                .foregroundColor: sigColor.withAlphaComponent(Double(alpha))
            ]
            let topLineWidth = NSAttributedString(string: artLines[0], attributes: [.font: artFont]).size().width
            NSAttributedString(string: " · \(signal.uppercased())", attributes: sigAttrs)
                .draw(at: NSPoint(x: rect.minX + pad + topLineWidth + 4, y: y))
        }

        y -= (artLineH * CGFloat(artLines.count) + 10)

        // --- Waiting banner ---
        if waitingForConfirmation {
            let bannerH: CGFloat = 22
            let bannerRect = CGRect(x: rect.minX + pad - 4, y: y - 4, width: rect.width - 2 * pad + 8, height: bannerH)
            let bannerPath = CGPath(roundedRect: bannerRect, cornerWidth: 6, cornerHeight: 6, transform: nil)
            let bannerPulse: CGFloat = pulsing ? (0.7 + 0.3 * CGFloat(sin(Double(pulsePhase) * 2))) : 0.7
            ctx.setFillColor(waitingColor.withAlphaComponent(Double(alpha) * 0.15 * Double(bannerPulse)).cgColor)
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

        y -= 4

        // --- Session tabs (clickable) ---
        if sessionDots.count > 1 {
            sessionTabRects = []
            // Section header
            let tabHeaderAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                .foregroundColor: faintColor
            ]
            NSAttributedString(string: "SESSIONS", attributes: tabHeaderAttrs)
                .draw(at: NSPoint(x: rect.minX + pad, y: y))
            y -= 18
            let tabFont = NSFont.monospacedSystemFont(ofSize: 10, weight: .medium)
            var tabX = rect.minX + pad
            for dot in sessionDots {
                let isPinned = dot.id == pinnedSessionId
                let isActive = dot.id == (activeSessionId ?? "")
                let dotColor = dot.color.isEmpty ? NSColor.gray : NSColor.fromHex(dot.color)
                let tabLabel = dot.label.isEmpty ? String(dot.id.prefix(6)) : dot.label
                let labelColor = isPinned ? dotColor : (isActive ? textColor : NSColor(white: 0.65, alpha: 1))
                let tabAttrs: [NSAttributedString.Key: Any] = [
                    .font: tabFont,
                    .foregroundColor: labelColor.withAlphaComponent(Double(alpha))
                ]
                let tabSize = (tabLabel as NSString).size(withAttributes: tabAttrs)
                let dotR: CGFloat = 3.5
                let fullW = dotR * 2 + 4 + tabSize.width + 8
                let tabRect = NSRect(x: tabX - 4, y: y - 3, width: fullW, height: tabSize.height + 6)
                sessionTabRects.append((rect: tabRect, sessionId: dot.id))

                // Background pill for all tabs (subtle), brighter for pinned
                let bgPath = CGPath(roundedRect: tabRect, cornerWidth: 5, cornerHeight: 5, transform: nil)
                let bgAlpha = isPinned ? 0.2 : 0.08
                let bgColor = isPinned ? dotColor : NSColor.white
                ctx.setFillColor(bgColor.withAlphaComponent(Double(alpha) * bgAlpha).cgColor)
                ctx.addPath(bgPath)
                ctx.fillPath()

                // Dot indicator
                let dotStatusColor = IslandView.dotStatusColors[dot.status] ?? NSColor.gray
                ctx.setFillColor(dotStatusColor.withAlphaComponent(Double(alpha)).cgColor)
                ctx.fillEllipse(in: CGRect(x: tabX, y: y + tabSize.height / 2 - dotR + 1, width: dotR * 2, height: dotR * 2))

                NSAttributedString(string: tabLabel, attributes: tabAttrs)
                    .draw(at: NSPoint(x: tabX + dotR * 2 + 4, y: y))
                tabX += fullW + 8
            }
            y -= 26
        } else {
            sessionTabRects = []
        }

        // --- User query (what the agent is working on) ---
        if let query = userQuery, !query.isEmpty {
            let qAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
                .foregroundColor: NSColor(white: 0.65, alpha: Double(alpha))
            ]
            let firstLine = query.components(separatedBy: .newlines).first ?? query
            let truncated = firstLine.count > 55 ? String(firstLine.prefix(52)) + "..." : firstLine
            NSAttributedString(string: "❯ \(truncated)", attributes: qAttrs)
                .draw(at: NSPoint(x: rect.minX + pad, y: y))
            y -= 18
        }

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
        NSAttributedString(string: "i:toggle  ·  w:window", attributes: hintAttrs)
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

    func updateSignals(phase: String, progress: String?, tool: String?, toolDetail: String?, files: Int, sessions: Int, tokens: Int, tokIn: Int, tokOut: Int, tokCacheRead: Int, tokCacheCreate: Int, errors: Int, thinking: Bool, waiting: Bool, waitingTool: String?, approved: String?, idleSeconds: Int, userQuery: String?, recentTools: [String], activeFile: String?, elapsed: Int, sessionDots: [(status: String, label: String, color: String, id: String)], activeSessionColor: String?, activeSessionId: String?) {
        currentPhase = phase
        progressSignal = progress
        activeToolName = tool
        activeToolDetail = toolDetail
        activeFileCount = files
        sessionCount = sessions
        tokenCount = tokens
        self.tokIn = tokIn; self.tokOut = tokOut; self.tokCacheRead = tokCacheRead; self.tokCacheCreate = tokCacheCreate
        errorCount = errors
        thinkingActive = thinking
        waitingForConfirmation = waiting
        // pulsing is set separately via the JS payload
        self.waitingTool = waitingTool
        self.approvedTool = approved
        self.idleSeconds = idleSeconds
        self.sessionDots = sessionDots
        if let hex = activeSessionColor { self.activeSessionColor = NSColor.fromHex(hex) } else { self.activeSessionColor = nil }
        self.activeSessionId = activeSessionId
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
    var onSendWS: (([String: Any]) -> Void)? {
        didSet { islandView?.onSendWS = onSendWS }
    }

    // Cached signals so we can restore state after toggle
    private var lastSignals: (phase: String, progress: String?, tool: String?, toolDetail: String?, files: Int, sessions: Int, tokens: Int, tokIn: Int, tokOut: Int, tokCacheRead: Int, tokCacheCreate: Int, errors: Int, thinking: Bool, waiting: Bool, waitingTool: String?, approved: String?, idleSeconds: Int, userQuery: String?, recentTools: [String], activeFile: String?, elapsed: Int, sessionDots: [(status: String, label: String, color: String, id: String)], activeSessionColor: String?, activeSessionId: String?)?

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
        view.onSendWS = onSendWS

        // Restore last known state
        if let s = lastSignals {
            view.updateSignals(phase: s.phase, progress: s.progress, tool: s.tool, toolDetail: s.toolDetail, files: s.files, sessions: s.sessions, tokens: s.tokens, tokIn: s.tokIn, tokOut: s.tokOut, tokCacheRead: s.tokCacheRead, tokCacheCreate: s.tokCacheCreate, errors: s.errors, thinking: s.thinking, waiting: s.waiting, waitingTool: s.waitingTool, approved: s.approved, idleSeconds: s.idleSeconds, userQuery: s.userQuery, recentTools: s.recentTools, activeFile: s.activeFile, elapsed: s.elapsed, sessionDots: s.sessionDots, activeSessionColor: s.activeSessionColor, activeSessionId: s.activeSessionId)
        }
    }

    func show() { panel?.orderFrontRegardless() }
    func hide() { panel?.orderOut(nil) }

    func teardown() {
        panel?.orderOut(nil)
        panel = nil
        islandView = nil
    }

    func updateSignals(phase: String, progress: String?, tool: String?, toolDetail: String?, files: Int, sessions: Int, tokens: Int, tokIn: Int, tokOut: Int, tokCacheRead: Int, tokCacheCreate: Int, errors: Int, thinking: Bool, waiting: Bool, waitingTool: String?, approved: String?, idleSeconds: Int, userQuery: String?, recentTools: [String], activeFile: String?, elapsed: Int, sessionDots: [(status: String, label: String, color: String, id: String)], activeSessionColor: String?, activeSessionId: String?) {
        lastSignals = (phase, progress, tool, toolDetail, files, sessions, tokens, tokIn, tokOut, tokCacheRead, tokCacheCreate, errors, thinking, waiting, waitingTool, approved, idleSeconds, userQuery, recentTools, activeFile, elapsed, sessionDots, activeSessionColor, activeSessionId)
        islandView?.updateSignals(phase: phase, progress: progress, tool: tool, toolDetail: toolDetail, files: files, sessions: sessions, tokens: tokens, tokIn: tokIn, tokOut: tokOut, tokCacheRead: tokCacheRead, tokCacheCreate: tokCacheCreate, errors: errors, thinking: thinking, waiting: waiting, waitingTool: waitingTool, approved: approved, idleSeconds: idleSeconds, userQuery: userQuery, recentTools: recentTools, activeFile: activeFile, elapsed: elapsed, sessionDots: sessionDots, activeSessionColor: activeSessionColor, activeSessionId: activeSessionId)
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
    var wsTask: URLSessionWebSocketTask?
    var autoHideObserver: Any?
    var autoHideSuppressed = false

    // Island
    let island = IslandController()
    var islandEnabled = true
    var islandOnlyMode = false

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

        if message.name == "showWindow" {
            islandOnlyMode = false
            showWindow()
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
                tokIn: data["tokIn"] as? Int ?? 0,
                tokOut: data["tokOut"] as? Int ?? 0,
                tokCacheRead: data["tokCacheRead"] as? Int ?? 0,
                tokCacheCreate: data["tokCacheCreate"] as? Int ?? 0,
                errors: data["errors"] as? Int ?? 0,
                thinking: data["thinking"] as? Bool ?? false,
                waiting: data["waiting"] as? Bool ?? false,
                waitingTool: data["waitingTool"] as? String,
                approved: data["approved"] as? String,
                idleSeconds: data["idleSeconds"] as? Int ?? 0,
                userQuery: data["userQuery"] as? String,
                recentTools: data["recentTools"] as? [String] ?? [],
                activeFile: data["activeFile"] as? String,
                elapsed: data["elapsed"] as? Int ?? 0,
                sessionDots: (data["sessionDots"] as? [[String: String]])?.map { d in
                    (status: d["status"] ?? "working", label: d["label"] ?? "", color: d["color"] ?? "", id: d["id"] ?? "")
                } ?? [],
                activeSessionColor: data["activeSessionColor"] as? String,
                activeSessionId: data["activeSessionId"] as? String
            )
            island.islandView?.pulsing = data["pulsing"] as? Bool ?? false
            island.islandView?.rejectedTool = data["rejected"] as? String
            island.islandView?.planningStrike = data["planningStrike"] as? Bool ?? false
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        port = ProcessInfo.processInfo.environment["LOUPE_PORT"] ?? "8390"

        // Global hotkeys (requires Accessibility permissions — best-effort)
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
            if event.keyCode == 13 && !event.modifierFlags.contains(.shift) { // Cmd+W
                self?.window.orderOut(nil)
                self?.islandOnlyMode = true
                return nil
            }
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

        // Load page in compact (minimal) mode
        loadPage()
        positionWindow()

        // Only show window if not island-only mode
        islandOnlyMode = ProcessInfo.processInfo.environment["LOUPE_ISLAND_ONLY"] == "1"
            || CommandLine.arguments.contains("--island-only")
        if islandOnlyMode {
            // Window stays hidden — island gets data via direct WebSocket
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        // Launch island
        if islandEnabled, let screen = NSScreen.main {
            island.setup(screen: screen)
            island.show()
        }

        // Wire island → WebSocket callback
        island.onSendWS = { [weak self] msg in
            guard let self = self, let task = self.wsTask else { return }
            if let data = try? JSONSerialization.data(withJSONObject: msg),
               let str = String(data: data, encoding: .utf8) {
                task.send(.string(str)) { _ in }
            }
        }

        // Connect to server WebSocket for island state updates
        connectIslandWebSocket()

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
        config.userContentController.add(self, name: "showWindow")
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
        // Check for signal file from TUI "w" key
        let signalPath = NSHomeDirectory() + "/.claude/logs/loupe-show-window"
        if FileManager.default.fileExists(atPath: signalPath) {
            try? FileManager.default.removeItem(atPath: signalPath)
            islandOnlyMode = false
            showWindow()
            return false
        }
        if !flag || !window.isVisible {
            if !islandOnlyMode {
                showWindow()
            }
        }
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // Dock click when window is hidden — bring it back (but not in island-only mode)
        if !window.isVisible && !islandOnlyMode {
            showWindow()
        }
    }

    // MARK: - Direct WebSocket for island state

    func connectIslandWebSocket() {
        let url = URL(string: "ws://localhost:\(port)/ws")!
        let session = URLSession(configuration: .default)
        wsTask = session.webSocketTask(with: url)
        wsTask?.resume()
        receiveIslandMessage()
    }

    func receiveIslandMessage() {
        wsTask?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message,
                   let data = text.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let type = json["type"] as? String {
                    DispatchQueue.main.async {
                        if type == "island_state", let stateData = json["data"] as? [String: Any] {
                            self.applyIslandState(stateData)
                        } else if type == "toggle_island" {
                            self.toggleIsland()
                        } else if type == "toggle_window" || type == "show_window" {
                            self.toggleWindow()
                        }
                    }
                }
                self.receiveIslandMessage()
            case .failure(_):
                // Reconnect after delay
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    self?.connectIslandWebSocket()
                }
            }
        }
    }

    func applyIslandState(_ data: [String: Any]) {
        island.updateSignals(
            phase: data["phase"] as? String ?? "idle",
            progress: data["progress"] as? String,
            tool: data["tool"] as? String,
            toolDetail: data["toolDetail"] as? String,
            files: data["files"] as? Int ?? 0,
            sessions: data["sessions"] as? Int ?? 0,
            tokens: data["tokens"] as? Int ?? 0,
            tokIn: data["tokIn"] as? Int ?? 0,
            tokOut: data["tokOut"] as? Int ?? 0,
            tokCacheRead: data["tokCacheRead"] as? Int ?? 0,
            tokCacheCreate: data["tokCacheCreate"] as? Int ?? 0,
            errors: data["errors"] as? Int ?? 0,
            thinking: data["thinking"] as? Bool ?? false,
            waiting: data["waiting"] as? Bool ?? false,
            waitingTool: data["waitingTool"] as? String,
            approved: data["approved"] as? String,
            idleSeconds: data["idleSeconds"] as? Int ?? 0,
            userQuery: data["userQuery"] as? String,
            recentTools: data["recentTools"] as? [String] ?? [],
            activeFile: data["activeFile"] as? String,
            elapsed: data["elapsed"] as? Int ?? 0,
            sessionDots: (data["sessionDots"] as? [[String: Any]])?.map { d in
                (status: d["status"] as? String ?? "working",
                 label: d["label"] as? String ?? "",
                 color: d["color"] as? String ?? "",
                 id: d["id"] as? String ?? "")
            } ?? [],
            activeSessionColor: data["activeSessionColor"] as? String,
            activeSessionId: data["activeSessionId"] as? String
        )
        island.islandView?.pulsing = data["pulsing"] as? Bool ?? false
        island.islandView?.rejectedTool = data["rejected"] as? String
        island.islandView?.planningStrike = data["planningStrike"] as? Bool ?? false
        island.islandView?.pinnedSessionId = data["pinnedSessionId"] as? String
    }

    func applicationWillTerminate(_ notification: Notification) {
        wsTask?.cancel(with: .goingAway, reason: nil)
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
