import SwiftUI
import WebKit
import AVFoundation

@main
struct WaselApp: App {
    init() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .videoChat, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        try? s.setActive(true)
        UIApplication.shared.isIdleTimerDisabled = true
    }
    var body: some Scene {
        WindowGroup { RootView().preferredColorScheme(.dark) }
    }
}

enum Server {
    static let key = "serverURL"
    static var url: String {
        get {
            if let s = UserDefaults.standard.string(forKey: key), !s.isEmpty { return s }
            return (Bundle.main.object(forInfoDictionaryKey: "WaselServerURL") as? String) ?? ""
        }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}

let bg = Color(red: 0.027, green: 0.035, blue: 0.059)
let green = Color(red: 0, green: 0.82, blue: 0.63)

struct RootView: View {
    @State private var url = Server.url
    @State private var failed = false
    @State private var reloadToken = 0
    @State private var editing = false

    var body: some View {
        ZStack {
            bg.ignoresSafeArea()
            if url.isEmpty || editing {
                SetupView(url: $url) { editing = false; failed = false; reloadToken += 1 }
            } else if failed {
                VStack(spacing: 18) {
                    Image(systemName: "wifi.exclamationmark").font(.system(size: 54)).foregroundColor(.gray)
                    Text("تعذّر الاتصال بالسيرفر").font(.title3.bold()).foregroundColor(.white)
                    Button("إعادة المحاولة") { failed = false; reloadToken += 1 }
                        .padding(.horizontal, 30).padding(.vertical, 12).background(green).foregroundColor(.white).clipShape(Capsule())
                    Button("تغيير عنوان السيرفر") { editing = true }.foregroundColor(green)
                }
            } else {
                WebView(url: url, reloadToken: reloadToken, failed: $failed).ignoresSafeArea()
            }
        }
        .environment(\.layoutDirection, .rightToLeft)
    }
}

struct SetupView: View {
    @Binding var url: String
    var done: () -> Void
    @State private var text = Server.url

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "bubble.left.and.bubble.right.fill").font(.system(size: 60)).foregroundColor(green)
            Text("واصل").font(.largeTitle.bold()).foregroundColor(.white)
            Text("أدخل عنوان السيرفر").foregroundColor(.gray)
            TextField("https://wasel-chat.xxx.workers.dev", text: $text)
                .keyboardType(.URL).autocapitalization(.none).disableAutocorrection(true)
                .environment(\.layoutDirection, .leftToRight)
                .padding().background(Color.white.opacity(0.08)).cornerRadius(12).foregroundColor(.white)
            Button("حفظ") {
                var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty && !t.hasPrefix("http") { t = "https://" + t }
                t = t.replacingOccurrences(of: "wss://", with: "https://")
                Server.url = t; url = t; done()
            }
            .frame(maxWidth: .infinity).padding(.vertical, 14).background(green).foregroundColor(.white).clipShape(Capsule())
        }.padding(28)
    }
}

struct WebView: UIViewRepresentable {
    let url: String
    let reloadToken: Int
    @Binding var failed: Bool

    func makeCoordinator() -> Coord { Coord(self) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.isOpaque = false
        w.backgroundColor = UIColor(red: 0.027, green: 0.035, blue: 0.059, alpha: 1)
        w.scrollView.backgroundColor = w.backgroundColor
        w.scrollView.bounces = false
        w.scrollView.contentInsetAdjustmentBehavior = .never
        w.allowsBackForwardNavigationGestures = true
        w.uiDelegate = context.coordinator
        w.navigationDelegate = context.coordinator
        context.coordinator.load(w)
        return w
    }

    func updateUIView(_ w: WKWebView, context: Context) {
        if context.coordinator.token != reloadToken { context.coordinator.token = reloadToken; context.coordinator.load(w) }
    }

    final class Coord: NSObject, WKUIDelegate, WKNavigationDelegate {
        var parent: WebView
        var token: Int
        init(_ p: WebView) { parent = p; token = p.reloadToken }

        func load(_ w: WKWebView) {
            guard let u = URL(string: parent.url) else { parent.failed = true; return }
            w.load(URLRequest(url: u, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 20))
        }

        // منح صلاحية المايك والكاميرا تلقائياً لصفحة التطبيق
        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.grant)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
        private func fail(_ e: Error) {
            if (e as NSError).code == NSURLErrorCancelled { return }
            DispatchQueue.main.async { self.parent.failed = true }
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "حسناً", style: .default) { _ in completionHandler() })
            present(a, orElse: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "إلغاء", style: .cancel) { _ in completionHandler(false) })
            a.addAction(UIAlertAction(title: "نعم", style: .destructive) { _ in completionHandler(true) })
            present(a) { completionHandler(false) }
        }

        private func present(_ vc: UIViewController, orElse: @escaping () -> Void) {
            let root = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
            var top = root
            while let p = top?.presentedViewController { top = p }
            if let top = top { top.present(vc, animated: true) } else { orElse() }
        }
    }
}
