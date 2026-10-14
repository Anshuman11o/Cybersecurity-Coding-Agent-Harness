import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectSinkSignals, type Signal } from './signal-detector.js'

const fixtures: Record<string, string[]> = {
  route_handler: ['class Screen : AppCompatActivity()', 'registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)'],
  db_query: ['db.rawQuery("SELECT * FROM records WHERE name = \'" + name + "\'", null)', 'db.execSQL("DELETE FROM records WHERE id=" + id)'],
  model_schema: ['@Entity data class Record(val id: Int)', 'class Store : SQLiteOpenHelper(context, "store", null, 1)'],
  model_write: ['prefs.edit().putString("session", token).apply()'],
  http_outbound: ['val client = OkHttpClient()', 'URL(address).openConnection()'],
  auth_check: ['override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}', 'clipboard.setPrimaryClip(ClipData.newPlainText("session", token))'],
  crypto_op: ['MessageDigest.getInstance("MD5")', 'MessageDigest.getInstance("SHA1")', 'Cipher.getInstance("AES/ECB/PKCS5Padding")', 'object : HostnameVerifier { override fun verify(host: String, session: SSLSession) = true }'],
  html_sink: ['browser.settings.javaScriptEnabled = true', 'browser.addJavascriptInterface(bridge, "app")', 'browser.settings.allowUniversalAccessFromFileURLs = true'],
  dynamic_exec: ['Runtime.getRuntime().exec(command)', 'ProcessBuilder("sh", "-c", command).start()'],
  deserialize: ['ObjectInputStream(stream).readObject()'],
  file_io: ['context.getSharedPreferences("account", 0).edit().putString("password", password)', 'FileOutputStream(file).write(secret.toByteArray())', 'file.writeText(secret)', 'clipboard.setPrimaryClip(clip)'],
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
