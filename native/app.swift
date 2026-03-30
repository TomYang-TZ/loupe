import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow?
    var hasPositionedPopover = false
    var popoverPanel: NSPanel!
    var popoverWebView: WKWebView!
    var windowWebView: WKWebView!
    var retryCount = 0
    let maxRetries = 60
    var port: String = "8390"
    var retryTimer: Timer?
    var isWindowMode = false

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "themeChange", let theme = message.body as? String {
            let appearance = theme == "light" ? NSAppearance(named: .aqua) : NSAppearance(named: .darkAqua)
            let bgColor = theme == "light"
                ? NSColor(red: 248.0/255, green: 250.0/255, blue: 252.0/255, alpha: 1.0)
                : NSColor(red: 15.0/255, green: 23.0/255, blue: 42.0/255, alpha: 1.0)

            popoverPanel.appearance = appearance
            popoverPanel.backgroundColor = bgColor
            if let w = window {
                w.appearance = appearance
                w.backgroundColor = bgColor
            }
        }
        if message.name == "pinPopover", let pinned = message.body as? Bool {
            popoverPanel.hidesOnDeactivate = !pinned
        }
        if message.name == "switchMode", let mode = message.body as? String {
            if mode == "window" {
                switchToWindowMode()
            } else {
                switchToMenuBarMode()
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        port = ProcessInfo.processInfo.environment["LOUPE_PORT"] ?? "8390"

        // Global hotkey: Cmd+Shift+L to toggle popover
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.modifierFlags.contains([.command, .shift]) && event.keyCode == 37 { // L key
                self?.togglePopover()
            }
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.modifierFlags.contains([.command, .shift]) && event.keyCode == 37 { // L key
                self?.togglePopover()
                return nil
            }
            return event
        }

        // Borderless panel (positioned top-right, remembers position)
        popoverPanel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 600),
            styleMask: [.nonactivatingPanel, .titled, .resizable, .closable],
            backing: .buffered,
            defer: false
        )
        popoverPanel.titlebarAppearsTransparent = true
        popoverPanel.titleVisibility = .hidden
        popoverPanel.isMovableByWindowBackground = true
        popoverPanel.level = .popUpMenu
        popoverPanel.appearance = NSAppearance(named: .darkAqua)
        popoverPanel.backgroundColor = NSColor(red: 15.0/255, green: 23.0/255, blue: 42.0/255, alpha: 1.0)
        popoverPanel.isReleasedWhenClosed = false
        popoverPanel.hidesOnDeactivate = false
        popoverPanel.minSize = NSSize(width: 320, height: 300)
        popoverPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        popoverPanel.hasShadow = true
        popoverPanel.setFrameAutosaveName("loupe-popover")

        popoverWebView = makeWebView()
        if let cv = popoverPanel.contentView {
            cv.addSubview(popoverWebView)
            popoverWebView.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                popoverWebView.topAnchor.constraint(equalTo: cv.topAnchor),
                popoverWebView.bottomAnchor.constraint(equalTo: cv.bottomAnchor),
                popoverWebView.leadingAnchor.constraint(equalTo: cv.leadingAnchor),
                popoverWebView.trailingAnchor.constraint(equalTo: cv.trailingAnchor),
            ])
        }

        // Intercept Cmd+/- for zoom, Cmd+Shift+/- for columns
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.modifierFlags.contains(.command) else { return event }
            let wv = self?.activeWebView
            let hasShift = event.modifierFlags.contains(.shift)
            if event.keyCode == 24 {  // =/+ key
                if hasShift {
                    wv?.evaluateJavaScript("setGridCols(gridCols+1)", completionHandler: nil)
                } else {
                    wv?.evaluateJavaScript("adjustFontSize(1)", completionHandler: nil)
                }
                return nil
            }
            if event.keyCode == 27 {  // -/_ key
                if hasShift {
                    wv?.evaluateJavaScript("setGridCols(gridCols-1)", completionHandler: nil)
                } else {
                    wv?.evaluateJavaScript("adjustFontSize(-1)", completionHandler: nil)
                }
                return nil
            }
            return event
        }

        // Load popover page and show it
        loadPage(webView: popoverWebView, minimal: true)
        positionPopoverPanel()
        popoverPanel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController.add(self, name: "themeChange")
        config.userContentController.add(self, name: "switchMode")
        config.userContentController.add(self, name: "pinPopover")
        config.websiteDataStore = WKWebsiteDataStore.default()

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.setValue(false, forKey: "drawsBackground")
        wv.allowsMagnification = false
        return wv
    }

    var activeWebView: WKWebView {
        return isWindowMode ? windowWebView : popoverWebView
    }

    @objc func togglePopover() {
        if isWindowMode {
            if let w = window {
                if w.isVisible {
                    w.orderOut(nil)
                } else {
                    w.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                }
            }
            return
        }

        if popoverPanel.isVisible {
            popoverPanel.orderOut(nil)
        } else {
            positionPopoverPanel()
            popoverPanel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func positionPopoverPanel() {
        // Only set initial position once — after that, autosave handles it
        if hasPositionedPopover { return }
        hasPositionedPopover = true
        guard let screen = NSScreen.main else { return }
        let visibleFrame = screen.visibleFrame
        let panelSize = popoverPanel.frame.size
        let x = visibleFrame.maxX - panelSize.width - 16
        let y = visibleFrame.maxY - panelSize.height - 8
        popoverPanel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    func switchToWindowMode() {
        // Close popover panel
        popoverPanel.orderOut(nil)

        // Show in dock + Cmd+Tab
        NSApp.setActivationPolicy(.regular)

        // Create window if needed
        if window == nil {
            let screen = NSScreen.main!.visibleFrame
            let width: CGFloat = 560
            let height: CGFloat = screen.height * 0.85
            let x = screen.maxX - width - 16
            let y = screen.minY + (screen.height - height) / 2

            let w = NSWindow(
                contentRect: NSRect(x: x, y: y, width: width, height: height),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            w.title = "Loupe"
            w.titlebarAppearsTransparent = true
            w.appearance = NSAppearance(named: .darkAqua)
            w.backgroundColor = NSColor(red: 15.0/255, green: 23.0/255, blue: 42.0/255, alpha: 1.0)
            w.isReleasedWhenClosed = false
            w.minSize = NSSize(width: 380, height: 400)
            w.setFrameAutosaveName("logstream-main")
            w.level = .floating
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

            windowWebView = makeWebView()
            if let cv = w.contentView {
                cv.addSubview(windowWebView)
                windowWebView.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    windowWebView.topAnchor.constraint(equalTo: cv.topAnchor),
                    windowWebView.bottomAnchor.constraint(equalTo: cv.bottomAnchor),
                    windowWebView.leadingAnchor.constraint(equalTo: cv.leadingAnchor),
                    windowWebView.trailingAnchor.constraint(equalTo: cv.trailingAnchor),
                ])
            }
            window = w
            loadPage(webView: windowWebView, minimal: false)
        }

        isWindowMode = true
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func switchToMenuBarMode() {
        isWindowMode = false
        window?.orderOut(nil)

        // Show panel after a brief delay (allows activation policy change to settle)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self = self else { return }
            self.positionPopoverPanel()
            self.popoverPanel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func loadPage(webView: WKWebView, minimal: Bool) {
        let mode = minimal ? "?mode=minimal" : ""
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
        scheduleRetry(webView: webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("loupe: navigation error: \(error.localizedDescription)")
        scheduleRetry(webView: webView)
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

    func scheduleRetry(webView: WKWebView) {
        retryCount += 1
        if retryCount <= maxRetries {
            let delay = min(Double(retryCount) * 0.5, 3.0)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                let minimal = webView === self?.popoverWebView
                self?.loadPage(webView: webView, minimal: minimal)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // `open Loupe.app` again → show the popover
        if !flag || !popoverPanel.isVisible {
            togglePopover()
        }
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
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
