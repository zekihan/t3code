package expo.modules.t3clientcertificates.enroll

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import org.json.JSONException
import org.json.JSONObject

/**
 * The t3-mesh enrollment exchange (`internal/proto`): one length-prefixed JSON message each way.
 * A message is a 4-byte big-endian length and then `{"type":"<Type>","body":{...}}`.
 */
internal object EnrollWire {
  /** The ALPN the hub accepts without a client certificate (`proto.ALPNEnroll`). */
  const val ALPN = "t3-mesh-enroll/1"

  /** `proto.MaxEnrollSize`: the hub refuses a longer request. */
  const val MAX_REQUEST_BYTES = 4 shl 10

  /** The hub accepts up to 4 MiB (`proto.MaxMessageSize`); the app stops reading at 1 MiB. */
  const val MAX_REPLY_BYTES = 1 shl 20

  private const val LENGTH_PREFIX = 4
  private const val BYTE_MASK = 0xFF
  private const val BITS_PER_BYTE = 8
  private const val CONTROL_LIMIT = 0x20

  /** The `Enroll` message with its length prefix. */
  fun enrollRequest(token: String, csrPem: String): ByteArray {
    val json = "{\"type\":\"Enroll\",\"body\":{\"token\":${quote(token)},\"csr\":${quote(csrPem)}}}"
    val data = json.toByteArray(Charsets.UTF_8)
    if (data.size > MAX_REQUEST_BYTES) throw IOException("Enrollment request is too large.")
    val out = ByteArrayOutputStream()
    for (shift in (LENGTH_PREFIX - 1) downTo 0) {
      out.write((data.size shr (shift * BITS_PER_BYTE)) and BYTE_MASK)
    }
    out.write(data)
    return out.toByteArray()
  }

  /** What the hub answered. Unknown types are kept so the caller can report them. */
  sealed interface Reply {
    data class Enrolled(
      val certificate: String,
      val chain: String,
      val caBundle: String?,
      val caRevision: String?
    ) : Reply

    data class Reject(val reason: String, val detail: String) : Reply

    data class Unexpected(val type: String) : Reply
  }

  /** Reads one message of at most [limit] bytes. Fails on a truncated or malformed message. */
  fun readReply(input: InputStream, limit: Int = MAX_REPLY_BYTES): Reply {
    val data = DataInputStream(input)
    val size = readLength(data)
    if (size < 0 || size > limit) throw IOException("The hub's answer is too large.")
    return parseReply(String(readBody(data, size), Charsets.UTF_8))
  }

  private fun readLength(data: DataInputStream): Int =
    try {
      data.readInt()
    } catch (error: EOFException) {
      throw IOException("The hub closed the connection without answering.", error)
    }

  private fun readBody(data: DataInputStream, size: Int): ByteArray =
    try {
      ByteArray(size).also { data.readFully(it) }
    } catch (error: EOFException) {
      throw IOException("The hub's answer was cut short.", error)
    }

  fun parseReply(json: String): Reply =
    try {
      val envelope = JSONObject(json)
      val body = envelope.optJSONObject("body") ?: JSONObject()
      when (val type = envelope.getString("type")) {
        "Enrolled" ->
          Reply.Enrolled(
            certificate = body.getString("certificate"),
            chain = body.optString("chain", ""),
            caBundle = body.optStringOrNull("caBundle"),
            caRevision = body.optStringOrNull("caRevision")
          )
        "Reject" -> Reply.Reject(body.optString("reason", ""), body.optString("detail", ""))
        else -> Reply.Unexpected(type)
      }
    } catch (error: JSONException) {
      throw IOException("The hub's answer was not understood.", error)
    }

  /** JSON string quoting like Go's `encoding/json` without HTML escaping: `/` stays as it is. */
  fun quote(value: String): String {
    val out = StringBuilder("\"")
    for (c in value) {
      when {
        c == '"' -> out.append("\\\"")
        c == '\\' -> out.append("\\\\")
        c == '\n' -> out.append("\\n")
        c == '\r' -> out.append("\\r")
        c == '\t' -> out.append("\\t")
        c.code < CONTROL_LIMIT -> out.append("\\u%04x".format(c.code))
        else -> out.append(c)
      }
    }
    return out.append('"').toString()
  }
}

internal fun JSONObject.optStringOrNull(name: String): String? =
  if (has(name) && !isNull(name)) getString(name).takeIf { it.isNotEmpty() } else null
