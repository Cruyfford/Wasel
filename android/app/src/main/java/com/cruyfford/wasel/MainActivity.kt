package com.cruyfford.wasel

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import android.webkit.*
import android.widget.EditText
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var pendingRequest: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val prefs by lazy { getSharedPreferences("wasel", MODE_PRIVATE) }
    private val nprefs by lazy { WaselService.prefs(this) }

    private var autoAnswer: String? = null

    private val serverUrl: String
        get() = prefs.getString("server", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.SERVER_URL

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val data = res.data
        val uris = mutableListOf<Uri>()
        if (res.resultCode == RESULT_OK && data != null) {
            data.clipData?.let { c -> for (i in 0 until c.itemCount) uris += c.getItemAt(i).uri }
            if (uris.isEmpty()) data.data?.let { uris += it }
        }
        cb.onReceiveValue(uris.toTypedArray())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (nprefs.getBoolean("secure", false)) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        volumeControlStream = AudioManager.STREAM_VOICE_CALL

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#07090F"))
        setContentView(web)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            setSupportZoom(false)
        }
        web.addJavascriptInterface(Bridge(), "WaselNative")

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handlePermission(request) }
            }
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                val i = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    val types = params.acceptTypes.filter { it.isNotBlank() }
                    type = if (types.size == 1) types[0].split(",")[0] else "*/*"
                    if (types.size == 1 && types[0].contains(",")) putExtra(Intent.EXTRA_MIME_TYPES, types[0].split(",").toTypedArray())
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                return try { pickFiles.launch(Intent.createChooser(i, "اختر")); true } catch (_: Exception) { fileCallback = null; false }
            }
        }

        autoAnswer = intent?.getStringExtra("answer")
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) { injectAnswer() }
            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) showError()
            }
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "wasel" && u.host == "retry") { load(); return true }
                if (u.scheme == "wasel" && u.host == "server") { askServer(); return true }
                val host = Uri.parse(serverUrl).host
                if (u.host != host && (u.scheme == "http" || u.scheme == "https")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                    return true
                }
                return false
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        })

        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else if (serverUrl.isBlank()) askServer() else load()
    }

    private fun load() { web.loadUrl(serverUrl) }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra("answer")?.let { autoAnswer = it; injectAnswer() }
    }

    private fun injectAnswer() {
        val id = autoAnswer ?: return
        if (!id.matches(Regex("[a-z0-9]{1,20}"))) return
        autoAnswer = null
        js("window.WASEL_AUTOANSWER='$id';try{if(typeof C!=='undefined'&&C&&C.id==='$id'&&C.state==='incoming')document.getElementById('kAccept').click()}catch(e){}")
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    inner class Bridge {
        @JavascriptInterface
        fun hasBio(): Boolean = BiometricManager.from(this@MainActivity)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS

        @JavascriptInterface
        fun post(json: String) {
            val o = try { JSONObject(json) } catch (_: Exception) { return }
            runOnUiThread { onNative(o) }
        }
    }

    private fun onNative(o: JSONObject) {
        when (o.optString("type")) {
            "auth" -> {
                nprefs.edit()
                    .putString("token", o.optString("token"))
                    .putInt("me", o.optInt("me"))
                    .putString("server", o.optString("server"))
                    .apply()
                WaselService.start(this)
                askBattery()
            }
            "logout" -> {
                nprefs.edit().remove("token").apply()
                WaselService.stop(this)
            }
            "prefs" -> {
                val secure = o.optBoolean("secure")
                nprefs.edit().putBoolean("msgN", o.optBoolean("msgN", true)).putBoolean("callN", o.optBoolean("callN", true)).putBoolean("secure", secure).apply()
                if (secure) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                if (!o.optBoolean("msgN", true) && !o.optBoolean("callN", true)) WaselService.stop(this) else WaselService.start(this)
            }
            "save" -> saveFile(o.optString("name", "file"), o.optString("mime", "application/octet-stream"), o.optString("data"))
            "bio" -> bio(o.optString("reason", "واصل"))
        }
    }

    private fun askBattery() {
        if (Build.VERSION.SDK_INT < 23 || prefs.getBoolean("askedBattery", false)) return
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        prefs.edit().putBoolean("askedBattery", true).apply()
        AlertDialog.Builder(this)
            .setTitle("الرنين في الخلفية")
            .setMessage("حتى يرن واصل والجوال مقفل، اسمح له بالعمل في الخلفية بدون قيود البطارية.")
            .setPositiveButton("سماح") { _, _ ->
                try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) } catch (_: Exception) {}
            }
            .setNegativeButton("لاحقاً", null)
            .show()
    }

    private fun bio(reason: String) {
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { js("waselNative({type:'bio',ok:true})") }
            override fun onAuthenticationError(code: Int, msg: CharSequence) { js("waselNative({type:'bio',ok:false})") }
        })
        try {
            prompt.authenticate(BiometricPrompt.PromptInfo.Builder()
                .setTitle("واصل")
                .setSubtitle(reason)
                .setNegativeButtonText("إلغاء")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
                .build())
        } catch (_: Exception) { js("waselNative({type:'bio',ok:false})") }
    }

    private fun saveFile(name: String, mime: String, data: String) {
        Thread {
            try {
                val bytes = Base64.decode(data, Base64.DEFAULT)
                val clean = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "file" }
                if (Build.VERSION.SDK_INT >= 29) {
                    val cv = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, clean)
                        put(MediaStore.MediaColumns.MIME_TYPE, mime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Wasel")
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv) ?: throw Exception("no uri")
                    contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                } else {
                    val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Wasel").apply { mkdirs() }
                    File(dir, clean).writeBytes(bytes)
                }
                runOnUiThread { Toast.makeText(this, "✅ تم الحفظ في التنزيلات/Wasel", Toast.LENGTH_SHORT).show() }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "تعذّر الحفظ", Toast.LENGTH_SHORT).show() }
            }
        }.start()
    }

    private fun showError() {
        val html = """
            <html dir="rtl"><body style="background:#07090f;color:#f2f4f8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;gap:18px;text-align:center">
            <div style="font-size:52px">📡</div><h3>تعذّر الاتصال بالسيرفر</h3>
            <a href="wasel://retry" style="background:linear-gradient(135deg,#00d1a0,#00a3ff);color:#fff;padding:14px 34px;border-radius:24px;text-decoration:none;font-weight:bold">إعادة المحاولة</a>
            <a href="wasel://server" style="color:#00d1a0">تغيير عنوان السيرفر</a></body></html>
        """.trimIndent()
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    private fun askServer() {
        val input = EditText(this).apply { setText(serverUrl); hint = "https://wasel-chat.xxx.workers.dev" }
        AlertDialog.Builder(this)
            .setTitle("عنوان السيرفر")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("حفظ") { _, _ ->
                var t = input.text.toString().trim()
                if (t.isNotEmpty() && !t.startsWith("http")) t = "https://$t"
                prefs.edit().putString("server", t).apply()
                load()
            }.show()
    }

    private fun handlePermission(request: PermissionRequest) {
        val needed = mutableListOf<String>()
        for (r in request.resources) {
            if (r == PermissionRequest.RESOURCE_AUDIO_CAPTURE) needed += Manifest.permission.RECORD_AUDIO
            if (r == PermissionRequest.RESOURCE_VIDEO_CAPTURE) needed += Manifest.permission.CAMERA
        }
        val missing = needed.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) request.grant(request.resources)
        else { pendingRequest = request; ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1) }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code != 1) return
        val req = pendingRequest ?: return
        pendingRequest = null
        val granted = req.resources.filter {
            when (it) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                else -> false
            }
        }
        if (granted.isEmpty()) req.deny() else req.grant(granted.toTypedArray())
    }

    override fun onSaveInstanceState(out: Bundle) { super.onSaveInstanceState(out); web.saveState(out) }
    override fun onResume() {
        super.onResume(); web.onResume(); WaselService.appVisible = true
        getSystemService(android.app.NotificationManager::class.java).cancel(WaselService.ID_CALL)
    }
    override fun onPause() { super.onPause(); WaselService.appVisible = false }
    override fun onDestroy() { WaselService.appVisible = false; web.destroy(); super.onDestroy() }
}
