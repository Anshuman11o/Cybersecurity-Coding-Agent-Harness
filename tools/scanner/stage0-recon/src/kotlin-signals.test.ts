import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectSinkSignals, type Signal } from './signal-detector.js'

const fixtures: Record<string, string[]> = {
  route_handler: ['class Screen : AppCompatActivity()', 'registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)'],
  db_query: ['db.rawQuery("SELECT * FROM records WHERE name = \'" + name + "\'", null)', 'db.execSQL("DELETE FROM records WHERE id=" + id)'],
  model_schema: ['@Entity data class Record(val id: Int)', 'class Store : SQLiteOpenHelper(context, "store", null, 1)'],
  model_write: ['prefs.edit().putString("session", token).apply()', 'editor.putInt("attempts", count)', 'editor.putBoolean("enabled", true)', 'editor.putLong("timestamp", now)', 'editor.putFloat("ratio", ratio)'],
  http_outbound: ['val client = OkHttpClient()', 'URL(address).openConnection()'],
  auth_check: ['override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}', 'context.checkSelfPermission(permission)'],
  crypto_op: ['MessageDigest.getInstance("MD5")', 'MessageDigest.getInstance("SHA1")', 'Cipher.getInstance("AES/ECB/PKCS5Padding")', 'object : HostnameVerifier { override fun verify(host: String, session: SSLSession) = true }', 'context.getSharedPreferences("account", 0)', 'clipboard.setPrimaryClip(clip)'],
  html_sink: ['browser.settings.javaScriptEnabled = true', 'browser.addJavascriptInterface(bridge, "app")', 'browser.settings.allowUniversalAccessFromFileURLs = true'],
  dynamic_exec: ['Runtime.getRuntime().exec(command)', 'ProcessBuilder("sh", "-c", command).start()'],
  deserialize: ['ObjectInputStream(stream).readObject()'],
  file_io: ['context.getSharedPreferences("account", 0).edit().putString("password", password)', 'FileOutputStream(file).write(secret.toByteArray())', 'file.writeText(secret)', 'val output = FileWriter(file)', 'val file = File(path)', 'context.getExternalFilesDir(null)', 'Environment.getExternalStorageDirectory()', 'clipboard.setPrimaryClip(clip)'],
  llm_call: ['client.generateContent(prompt)'],
  logging: ['Log.d("Account", password)', 'Log.i("Session", token)'],
}
for (const [signal, snippets] of Object.entries(fixtures)) {
  test(`Kotlin ${signal} detects platform sinks without JavaScript fallback`, () => {
    for (const source of snippets) assert.ok(detectSinkSignals('kotlin', source).includes(signal as Signal), source)
    assert.ok(!detectSinkSignals('kotlin', 'fun total(a: Int, b: Int) = a + b').includes(signal as Signal))
  })
}
test('Kotlin detectors remain bounded on large files', () => {
  for (const unit of ['a', ' ', 'a.b ', 'SELECT ', 'class X(a,']) {
    const start = performance.now()
    detectSinkSignals('kotlin', unit.repeat(Math.ceil(1_000_000 / unit.length)))
    assert.ok(performance.now() - start < 3000)
  }
})

test('component imports, mentions and helper types are not entry points', () => {
  for (const source of [
    'import android.app.Activity\nclass Formatter { fun format() = "ready" }',
    'val name = "AppCompatActivity"', 'class ActivityHelper { val receiver: BroadcastReceiver? = null }',
    'class Worker : ActivityHelper()',
  ]) assert.ok(!detectSinkSignals('kotlin', source).includes('route_handler'), source)
})
test('component declarations and lifecycle callbacks identify real entry surfaces', () => {
  for (const parent of ['Activity', 'AppCompatActivity', 'ComponentActivity', 'Fragment', 'BroadcastReceiver', 'ContentProvider', 'Service']) {
    assert.ok(detectSinkSignals('kotlin', `class Screen(val config: Config) : android.app.${parent}()`).includes('route_handler'))
  }
  assert.ok(detectSinkSignals('kotlin', 'override fun onReceive(context: Context, intent: Intent) {}').includes('route_handler'))
})
test('preference and clipboard operations route confidentiality without asserting an auth check', () => {
  for (const source of ['context.getSharedPreferences("account", 0)', 'clipboard.setPrimaryClip(ClipData.newPlainText("code", value))']) {
    const signals = detectSinkSignals('kotlin', source)
    assert.ok(signals.includes('crypto_op'))
    assert.ok(signals.includes('file_io'))
    assert.ok(!signals.includes('auth_check'))
  }
})
