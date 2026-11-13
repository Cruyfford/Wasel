package com.cruyfford.wasel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * خدمة تعمل في الخلفية: تبقي اتصالاً بالسيرفر حتى بعد الخروج من التطبيق،
 * فترن المكالمات وتظهر إشعارات الرسائل. المحتوى مشفّر ولا تقرأه الخدمة.
 */
class WaselService : Service() {
    companion object {
        @Volatile var appVisible = false
        const val CH_SVC = "wasel_service"
        const val CH_MSG = "wasel_messages"
        const val CH_CALL = "wasel_calls_v1"
        const val ID_SVC = 1
        const val ID_CALL = 2
        const val ACTION_DECLINE = "decline"

        fun prefs(ctx: Context) = ctx.getSharedPreferences("wasel_native", Context.MODE_PRIVATE)

        fun start(ctx: Context) {
            if (prefs(ctx).getString("token", "").isNullOrEmpty()) return
            val i = Intent(ctx, WaselService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (_: Exception) {}
        }

        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, WaselService::class.java)) }
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private var ws: WebSocket? = null
    private var retry = 0
    private var stopped = false
    private val main = Handler(Looper.getMainLooper())
    private var callId: String? = null
    private var callFrom: Int = 0
    private val nm by lazy { getSystemService(NotificationManager::class.java) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channels()
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, CH_SVC)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("واصل متصل")
            .setContentText("جاهز لاستقبال المكالمات والرسائل")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, ID_SVC, n, type)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DECLINE) {
            val id = intent.getStringExtra("callId")
            val to = intent.getIntExtra("from", 0)
            if (id != null && to != 0) {
                ws?.send(JSONObject().put("t", "signal").put("to", to)
                    .put("data", JSONObject().put("kind", "reject").put("callId", id)).toString())
            }
            cancelCall()
            return START_STICKY
        }
        if (ws == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        ws?.close(1000, "bye")
        ws = null
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun channels() {
        if (Build.VERSION.SDK_INT < 26) return
        nm.createNotificationChannel(NotificationChannel(CH_SVC, "اتصال الخلفية", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(CH_MSG, "الرسائل", NotificationManager.IMPORTANCE_HIGH).apply { enableVibration(true) })
        val ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        nm.createNotificationChannel(NotificationChannel(CH_CALL, "المكالمات الواردة", NotificationManager.IMPORTANCE_HIGH).apply {
            setSound(ring, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        })
    }

    private fun connect() {
        if (stopped) return
        val p = prefs(this)
        val token = p.getString("token", "") ?: ""
        val server = p.getString("server", "") ?: ""
        if (token.isEmpty() || server.isEmpty()) { stopSelf(); return }
        val url = server.replaceFirst("http", "ws").trimEnd('/') + "/ws?token=" + token
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { retry = 0 }
            override fun onMessage(webSocket: WebSocket, text: String) {
                try { handle(JSONObject(text)) } catch (_: Exception) {}
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { dropped(webSocket, code) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                dropped(webSocket, response?.code ?: 0)
            }
        })
    }

    private fun dropped(s: WebSocket, code: Int) {
        if (s != ws) return
        ws = null
        if (stopped) return
        if (code == 4001 || code == 401) { prefs(this).edit().remove("token").apply(); stopSelf(); return }
        val delay = minOf(30000L, 1000L shl minOf(retry++, 5))
        main.postDelayed({ if (ws == null) connect() }, delay)
    }

    private fun handle(o: JSONObject) {
        val p = prefs(this)
        val me = p.getInt("me", 0)
        when (o.optString("t")) {
            "msg" -> {
                val m = o.getJSONObject("m")
                if (m.optInt("a") == me || appVisible || !p.getBoolean("msgN", true)) return
                val name = o.optJSONObject("user")?.optString("name") ?: "واصل"
                val text = when (m.optString("kind")) {
                    "file" -> "📎 أرسل ملفاً"
                    "voice" -> "🎤 رسالة صوتية"
                    "game" -> "🎴 دعوة للعب ألوان"
                    "call" -> "📞 مكالمة"
                    else -> "🔒 رسالة جديدة"
                }
                notifyMsg(m.optInt("a"), name, text)
            }
            "signal" -> {
                val d = o.getJSONObject("data")
                val kind = d.optString("kind")
                val id = d.optString("callId")
                if (kind == "offer") {
                    if (appVisible || !p.getBoolean("callN", true)) return
                    ringCall(o.optInt("from"), o.optJSONObject("user")?.optString("name") ?: "واصل", id)
                } else if (id == callId && kind in listOf("end", "reject", "handled", "answer", "busy")) {
                    cancelCall()
                }
            }
        }
    }

    private fun notifyMsg(from: Int, name: String, text: String) {
        val open = PendingIntent.getActivity(this, from, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, CH_MSG)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(name)
            .setContentText(text)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .build()
        try { nm.notify(1000 + from, n) } catch (_: SecurityException) {}
    }

    private fun ringCall(from: Int, name: String, id: String) {
        callId = id; callFrom = from
        val openI = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val open = PendingIntent.getActivity(this, 7, openI, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val decl = PendingIntent.getService(this, 8,
            Intent(this, WaselService::class.java).setAction(ACTION_DECLINE).putExtra("callId", id).putExtra("from", from),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, CH_CALL)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(name)
            .setContentText("📞 مكالمة واردة — واصل")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(45000)
            .setFullScreenIntent(open, true)
            .setContentIntent(open)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "رفض", decl)
            .addAction(android.R.drawable.ic_menu_call, "رد", PendingIntent.getActivity(this, 9,
                Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("answer", id),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .build()
        n.flags = n.flags or Notification.FLAG_INSISTENT
        try { nm.notify(ID_CALL, n) } catch (_: SecurityException) {}
    }

    private fun cancelCall() { nm.cancel(ID_CALL); callId = null }
}
