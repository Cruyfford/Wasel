package com.cruyfford.wasel

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.webkit.*
import android.widget.EditText
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var pendingRequest: PermissionRequest? = null
    private val prefs by lazy { getSharedPreferences("wasel", MODE_PRIVATE) }

    private val serverUrl: String
        get() = prefs.getString("server", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.SERVER_URL

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
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
            setSupportZoom(false)
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handlePermission(request) }
            }
        }

        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) showError()
            }
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "wasel" && u.host == "retry") { load(); return true }
                if (u.scheme == "wasel" && u.host == "server") { askServer(); return true }
                return false
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else if (serverUrl.isBlank()) askServer() else load()
    }

    private fun load() { web.loadUrl(serverUrl) }

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
        if (missing.isEmpty()) {
            request.grant(request.resources)
        } else {
            pendingRequest = request
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
        }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
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
    override fun onResume() { super.onResume(); web.onResume() }
    override fun onDestroy() { web.destroy(); super.onDestroy() }
}
