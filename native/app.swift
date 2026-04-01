import Cocoa
import WebKit

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
    var blurObserver: Any?
    var focusObserver: Any?

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
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        port = ProcessInfo.processInfo.environment["LOUPE_PORT"] ?? "8390"

        // Global hotkey: Cmd+Shift+L to toggle window
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.modifierFlags.contains([.command, .shift]) && event.keyCode == 37 {
                self?.toggleWindow()
            }
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

        // Fade on blur when not auto-hiding
        blurObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification, object: window, queue: .main
        ) { [weak self] _ in
            guard let self = self, !self.autoHideEnabled else { return }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                self.window.animator().alphaValue = 0.55
            }
        }
        focusObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.15
                self.window.animator().alphaValue = 1.0
            }
        }

        // Force compact size on launch (autosave may have restored a different size)
        let currentOrigin = window.frame.origin
        window.setFrame(NSRect(origin: currentOrigin, size: compactSize), display: false)

        // Load page in compact (minimal) mode and show
        loadPage()
        positionWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController.add(self, name: "themeChange")
        config.userContentController.add(self, name: "switchMode")
        config.userContentController.add(self, name: "autoHide")
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
