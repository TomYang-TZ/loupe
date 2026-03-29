import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var retryCount = 0
    let maxRetries = 60
    var port: String = "8390"
    var retryTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        port = ProcessInfo.processInfo.environment["LOUPE_PORT"] ?? "8390"

        // Position window on the right side of the screen
        let screen = NSScreen.main!.visibleFrame
        let width: CGFloat = 560
        let height: CGFloat = screen.height * 0.85
        let x = screen.maxX - width - 16
        let y = screen.minY + (screen.height - height) / 2

        let rect = NSRect(x: x, y: y, width: width, height: height)

        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )

        window.title = "Loupe"
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 13.0/255, green: 17.0/255, blue: 23.0/255, alpha: 1.0)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 380, height: 400)
        window.setFrameAutosaveName("logstream-main")
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // WebView configuration
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Allow insecure localhost connections
        config.websiteDataStore = WKWebsiteDataStore.default()

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        if let contentView = window.contentView {
            contentView.addSubview(webView)
            webView.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                webView.topAnchor.constraint(equalTo: contentView.topAnchor),
                webView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
                webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            ])
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Start loading — use a timer-based retry that keeps trying
        loadPage()
    }

    func loadPage() {
        let url = URL(string: "http://localhost:\(port)")!
        NSLog("logstream: loading \(url) (attempt \(retryCount + 1))")
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    // Navigation succeeded
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("logstream: page loaded successfully")
        retryCount = 0
        retryTimer?.invalidate()
        retryTimer = nil
    }

    // Navigation failed — schedule retry
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("logstream: load failed: \(error.localizedDescription)")
        scheduleRetry()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("logstream: navigation error: \(error.localizedDescription)")
        scheduleRetry()
    }

    // Allow HTTP localhost (bypass ATS if needed)
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        // Trust localhost
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
        return true
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
