import UIKit
import WebKit
import AVFoundation
import UserNotifications
import LocalAuthentication

/// الجسر بين الواجهة والتطبيق + إبقاء الاتصال حياً في الخلفية حتى ترن المكالمات.
final class NativeHub: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    static let shared = NativeHub()
    weak var webView: WKWebView?
    private let d = UserDefaults.standard
    private var inCall = false
    private var isBackground = false
    private var player: AVAudioPlayer?
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pingTimer: Timer?
    private var ringTimer: Timer?
    private var retry = 0
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private(set) var ringingCall: (id: String, from: Int)?
    var autoAnswer: String?

    static var hasBiometrics: Bool {
        var e: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e)
    }

    func setup() {
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        c.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        let decline = UNNotificationAction(identifier: "decline", title: "رفض", options: [.destructive])
        let answer = UNNotificationAction(identifier: "answer", title: "رد", options: [.foreground])
        c.setNotificationCategories([UNNotificationCategory(identifier: "CALL", actions: [answer, decline], intentIdentifiers: [], options: [])])
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(willForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    // MARK: - رسائل من الواجهة
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let o = message.body as? [String: Any], let type = o["type"] as? String else { return }
        switch type {
        case "auth":
            d.set(o["token"] as? String, forKey: "n_token")
            d.set(o["me"] as? Int ?? 0, forKey: "n_me")
            d.set(o["server"] as? String, forKey: "n_server")
        case "logout":
            d.removeObject(forKey: "n_token"); stopBackground()
        case "prefs":
            d.set(o["msgN"] as? Bool ?? true, forKey: "n_msgN")
            d.set(o["callN"] as? Bool ?? true, forKey: "n_callN")
        case "call":
            inCall = o["active"] as? Bool ?? false
        case "bio":
            let ctx = LAContext()
            ctx.localizedCancelTitle = "إلغاء"
            ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: o["reason"] as? String ?? "واصل") { ok, _ in
                DispatchQueue.main.async { self.js("waselNative({type:'bio',ok:\(ok)})") }
            }
        case "save":
            save(name: o["name"] as? String ?? "file", data: o["data"] as? String ?? "")
        default: break
        }
    }

    func js(_ code: String) { webView?.evaluateJavaScript(code, completionHandler: nil) }

    private func save(name: String, data: String) {
        guard let bytes = Data(base64Encoded: data) else { return }
        let clean = name.replacingOccurrences(of: "/", with: "_")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(clean.isEmpty ? "file" : clean)
        do { try bytes.write(to: url) } catch { return }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        guard var top = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        while let p = top.presentedViewController { top = p }
        vc.popoverPresentationController?.sourceView = top.view
        vc.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
        top.present(vc, animated: true)
    }

    // MARK: - الخلفية
    private var enabled: Bool {
        guard let t = d.string(forKey: "n_token"), !t.isEmpty else { return false }
        return (d.object(forKey: "n_msgN") as? Bool ?? true) || (d.object(forKey: "n_callN") as? Bool ?? true)
    }

    @objc private func didBackground() {
        isBackground = true
        guard enabled, !inCall else { return }
        bgTask = UIApplication.shared.beginBackgroundTask { [weak self] in
            if let s = self { UIApplication.shared.endBackgroundTask(s.bgTask); s.bgTask = .invalid }
        }
        startSilentAudio()
        connect()
    }

    @objc private func willForeground() {
        isBackground = false
        stopBackground()
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["call"])
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .videoChat, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
        try? s.setActive(true)
    }

    private func stopBackground() {
        pingTimer?.invalidate(); pingTimer = nil
        ringTimer?.invalidate(); ringTimer = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        player?.stop(); player = nil
        if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
    }

    /// صوت صامت يبقي التطبيق حياً في الخلفية (يُخلط مع موسيقاك بدون إيقافها)
    private func startSilentAudio() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? s.setActive(true)
        if player == nil {
            player = try? AVAudioPlayer(data: NativeHub.silentWav())
            player?.numberOfLoops = -1
            player?.volume = 0.01
        }
        player?.play()
    }

    private static func silentWav() -> Data {
        let rate = 8000, samples = rate * 2
        var h = Data()
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; h.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: Int) { var x = UInt16(v).littleEndian; h.append(Data(bytes: &x, count: 2)) }
        h.append("RIFF".data(using: .ascii)!); u32(36 + samples * 2); h.append("WAVE".data(using: .ascii)!)
        h.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        h.append("data".data(using: .ascii)!); u32(samples * 2)
        h.append(Data(count: samples * 2))
        return h
    }

    private func connect() {
        guard isBackground, enabled, task == nil,
              let token = d.string(forKey: "n_token"), let server = d.string(forKey: "n_server"),
              var comps = URLComponents(string: server) else { return }
        comps.scheme = comps.scheme == "http" ? "ws" : "wss"
        comps.path = "/ws"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url else { return }
        if session == nil { session = URLSession(configuration: .default) }
        let t = session!.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            self?.task?.send(.string("{\"t\":\"ping\"}")) { _ in }
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let msg):
                self.retry = 0
                if case .string(let s) = msg, let data = s.data(using: .utf8),
                   let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async { self.handle(o) }
                }
                self.receive(t)
            case .failure:
                DispatchQueue.main.async {
                    guard self.task === t else { return }
                    self.task = nil
                    let delay = min(30.0, pow(2.0, Double(min(self.retry, 5))))
                    self.retry += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.connect() }
                }
            }
        }
    }

    private func handle(_ o: [String: Any]) {
        let me = d.integer(forKey: "n_me")
        switch o["t"] as? String {
        case "msg":
            guard (d.object(forKey: "n_msgN") as? Bool ?? true), !(o["muted"] as? Bool ?? false),
                  let m = o["m"] as? [String: Any], let from = m["a"] as? Int, from != me,
                  (m["kind"] as? String) != "sys" else { return }
            let name = (o["user"] as? [String: Any])?["name"] as? String ?? "واصل"
            var body: String
            switch m["kind"] as? String {
            case "file": body = "📎 أرسل ملفاً"
            case "voice": body = "🎤 رسالة صوتية"
            case "loc": body = "📍 أرسل موقعاً"
            case "contact": body = "👤 أرسل جهة اتصال"
            case "call": body = "📞 مكالمة"
            default: body = "🔒 رسالة جديدة"
            }
            var title = name
            if let g = o["group"] as? [String: Any] { title = g["name"] as? String ?? "مجموعة"; body = "\(name): \(body)" }
            notify(id: "m-\(from)-\(m["id"] ?? 0)", title: title, body: body, sound: .default)
        case "gcall":
            guard let gid = o["gid"] as? Int else { return }
            if o["a"] as? String == "ring" {
                guard (d.object(forKey: "n_callN") as? Bool ?? true), !(o["muted"] as? Bool ?? false) else { return }
                let g = (o["group"] as? [String: Any])?["name"] as? String ?? "مجموعة"
                let who = (o["user"] as? [String: Any])?["name"] as? String ?? ""
                ring(id: "g\(gid)", from: 0, name: "\(g) 👥", body: "📞 \(who) يدعوك لمكالمة جماعية")
            } else if o["a"] as? String == "state", (o["peers"] as? [Any])?.isEmpty ?? false, ringingCall?.id == "g\(gid)" {
                stopRing(missedFrom: nil)
            }
        case "signal":
            guard let data = o["data"] as? [String: Any], let kind = data["kind"] as? String else { return }
            let id = data["callId"] as? String ?? ""
            if kind == "offer" {
                guard (d.object(forKey: "n_callN") as? Bool ?? true), let from = o["from"] as? Int else { return }
                let name = (o["user"] as? [String: Any])?["name"] as? String ?? "واصل"
                ring(id: id, from: from, name: name, body: "📞 مكالمة واردة — واصل")
            } else if ["end", "reject", "handled", "answer", "busy"].contains(kind), ringingCall?.id == id {
                stopRing(missedFrom: kind == "end" ? (o["user"] as? [String: Any])?["name"] as? String : nil)
            }
        default: break
        }
    }

    private func notify(id: String, title: String, body: String, sound: UNNotificationSound?, category: String? = nil) {
        let c = UNMutableNotificationContent()
        c.title = title; c.body = body
        if let s = sound { c.sound = s }
        if let cat = category { c.categoryIdentifier = cat }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
    }

    private func ring(id: String, from: Int, name: String, body: String) {
        ringingCall = (id, from)
        var count = 0
        let fire = { [weak self] in
            self?.notify(id: "call", title: name, body: body, sound: UNNotificationSound(named: UNNotificationSoundName("ring.wav")), category: "CALL")
        }
        fire()
        ringTimer?.invalidate()
        ringTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] t in
            count += 1
            if count >= 3 || self?.ringingCall?.id != id { t.invalidate(); if self?.ringingCall?.id == id { self?.stopRing(missedFrom: name) }; return }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["call"])
            fire()
        }
    }

    private func stopRing(missedFrom: String?) {
        ringTimer?.invalidate(); ringTimer = nil
        ringingCall = nil
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["call"])
        if let n = missedFrom { notify(id: "missed-\(Date().timeIntervalSince1970)", title: n, body: "📵 مكالمة فائتة", sound: .default) }
    }

    // MARK: - الإشعارات
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([]) // التطبيق مفتوح: الواجهة تتكفّل
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        if r.notification.request.identifier == "call", let call = ringingCall {
            if r.actionIdentifier == "decline" && call.id.hasPrefix("g") { stopRing(missedFrom: nil) }
            else if r.actionIdentifier == "decline" {
                let msg = "{\"t\":\"signal\",\"to\":\(call.from),\"data\":{\"kind\":\"reject\",\"callId\":\"\(call.id)\"}}"
                task?.send(.string(msg)) { _ in }
                stopRing(missedFrom: nil)
            } else {
                autoAnswer = r.actionIdentifier == "answer" ? call.id : nil
                if let a = autoAnswer, a.range(of: "^g?[a-z0-9]{1,20}$", options: .regularExpression) != nil {
                    js("window.WASEL_AUTOANSWER='\(a)';try{if(typeof C!=='undefined'&&C&&C.id==='\(a)'&&C.state==='incoming')document.getElementById('kAccept').click();if(typeof S!=='undefined'&&S.gring&&'g'+S.gring.gid==='\(a)')document.getElementById('gAccept').click()}catch(e){}")
                }
            }
        }
        done()
    }
}
