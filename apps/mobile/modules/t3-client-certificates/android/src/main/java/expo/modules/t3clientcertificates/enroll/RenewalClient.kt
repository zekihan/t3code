package expo.modules.t3clientcertificates.enroll

import java.io.IOException
import javax.net.ssl.SSLException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject

internal const val RENEW_URL = "https://hub.mesh.noqer.com/api/v1/renew"

/** What the hub returned for a renewal: the same four fields `GET`-style as enrollment's reply. */
internal class RenewReply(
  val certificate: String,
  val chain: String,
  val caBundle: String?,
  val caRevision: String?
)

/** Posts a CSR for a new key; the current enrolled leaf authenticates the call. */
internal fun interface RenewExchange {
  fun renew(csrPem: String): RenewReply
}

/**
 * `POST /api/v1/renew` with the PEM request as the body. [client] must present the enrolled
 * identity for the hub's origin, which the app's transport does; the hub refuses any other
 * identity, a superseded leaf included, with 401 or 403.
 */
internal class RenewalClient(
  private val client: OkHttpClient,
  private val url: String = RENEW_URL
) : RenewExchange {
  override fun renew(csrPem: String): RenewReply {
    val request =
      Request.Builder()
        .url(url)
        // Bytes, not a String: OkHttp would append "; charset=utf-8" to the content type.
        .post(
          csrPem.toByteArray(Charsets.UTF_8).toRequestBody("application/x-pem-file".toMediaType())
        )
        .header("Accept", "application/json")
        .build()
    try {
      client.newCall(request).execute().use { response ->
        val body = response.body?.string().orEmpty()
        return when {
          response.code == 200 -> parse(body)
          response.code == 401 || response.code == 403 ->
            throw enrollmentError(EnrollCode.REENROLL_REQUIRED)
          response.code == 429 -> throw enrollmentError(EnrollCode.RATE_LIMITED)
          response.code == 502 -> throw enrollmentError(EnrollCode.ISSUANCE_FAILED)
          response.code in BAD_REQUEST_RANGE ->
            throw enrollmentError(EnrollCode.CSR_REJECTED, errorText(body))
          else -> throw enrollmentError(EnrollCode.HUB_ERROR, "HTTP ${response.code}")
        }
      }
    } catch (error: IOException) {
      throw if (clientCertificateRefused(error)) {
        enrollmentError(EnrollCode.REENROLL_REQUIRED, cause = error)
      } else {
        classifyTransportFailure(EnrollPhase.CONNECT, error)
      }
    }
  }

  private fun parse(body: String): RenewReply =
    try {
      val json = JSONObject(body)
      RenewReply(
        certificate = json.getString("certificate"),
        chain = json.optString("chain", ""),
        caBundle = json.optStringOrNull("caBundle"),
        caRevision = json.optStringOrNull("caRevision")
      )
    } catch (error: JSONException) {
      throw enrollmentError(EnrollCode.BAD_REPLY, "the renewal answer was not understood", error)
    }

  private fun errorText(body: String) = body.trim().lineSequence().firstOrNull()?.take(MAX_DETAIL)

  private companion object {
    val BAD_REQUEST_RANGE = 400..499
    const val MAX_DETAIL = 200
  }
}

/**
 * The hub (or its proxy) rejected the client certificate during the handshake: an expired,
 * unknown-CA or otherwise refused leaf. A server-certificate failure is not that, and neither is a
 * dropped connection.
 */
internal fun clientCertificateRefused(error: Throwable): Boolean =
  !isCertificateFailure(error) &&
    generateSequence(error) { it.cause }.any {
      it is SSLException &&
        it.message.orEmpty().lowercase().let { text ->
          "certificate" in text || "unknown_ca" in text
        }
    }
