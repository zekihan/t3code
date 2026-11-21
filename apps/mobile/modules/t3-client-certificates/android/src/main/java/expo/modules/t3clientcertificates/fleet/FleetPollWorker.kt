package expo.modules.t3clientcertificates.fleet

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import expo.modules.t3clientcertificates.MESH_HUB_ORIGIN
import expo.modules.t3clientcertificates.T3CertificateTransport
import expo.modules.t3clientcertificates.enroll.clientCertificateRefused
import java.io.IOException
import java.net.HttpURLConnection.HTTP_FORBIDDEN
import java.net.HttpURLConnection.HTTP_UNAUTHORIZED
import java.net.HttpURLConnection.HTTP_UNAVAILABLE
import java.security.GeneralSecurityException
import java.util.UUID
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Request
import okhttp3.Response

class FleetPollWorker(context: Context, parameters: WorkerParameters) : Worker(
  context,
  parameters
) {
  @Volatile private var activeCall: Call? = null

  override fun doWork(): Result {
    try {
      checkFleet(T3CertificateTransport.install(applicationContext))
    } catch (_: GeneralSecurityException) {
      // The Keystore could not be read.
    }
    return Result.success()
  }

  private fun checkFleet(transport: T3CertificateTransport) {
    val notifications = transport.fleetNotifications
    val session = notifications.currentSession() ?: return
    val generation = synchronized(transport.lock) { transport.generation(MESH_HUB_ORIGIN) }
    val enrollment = transport.enrollment.status()?.let {
      FleetEnrollment(it.issuedAt, it.state != "valid", it.lastError != null)
    }
    val reply = if (enrollment?.needsReenrollment == true || isStopped ||
      !notifications.reservePoll(session)
    ) {
      FleetReply.Unavailable
    } else {
      poll(transport, generation)
    }
    synchronized(transport.lock) {
      if (!isStopped && generation === transport.generation(MESH_HUB_ORIGIN)) {
        notifications.finish(
          session,
          (reply as? FleetReply.Fetched)?.machines,
          enrollment,
          reply == FleetReply.Refused
        )
      }
    }
  }

  private fun poll(transport: T3CertificateTransport, generation: Any): FleetReply {
    val id = UUID.randomUUID().toString()
    val call = createCall(transport, generation, id) ?: return FleetReply.Unavailable
    activeCall = call
    return try {
      if (isStopped) FleetReply.Unavailable else call.execute().use(::readReply)
    } catch (error: IOException) {
      if (clientCertificateRefused(error)) FleetReply.Refused else FleetReply.Unavailable
    } finally {
      activeCall = null
      transport.calls.remove(id)
    }
  }

  private fun createCall(transport: T3CertificateTransport, generation: Any, id: String): Call? {
    val client = transport.fileClient.newBuilder()
      .callTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
      .retryOnConnectionFailure(false)
      .addNetworkInterceptor { chain ->
        val response = chain.proceed(chain.request())
        // OkHttp retries a 503 with Retry-After: 0 even with retryOnConnectionFailure off.
        if (response.code == HTTP_UNAVAILABLE) {
          response.newBuilder().removeHeader("Retry-After").build()
        } else {
          response
        }
      }
      .build()
    val request = Request.Builder()
      .url("${MESH_HUB_ORIGIN}api/v1/fleet")
      .header("Accept", "application/json")
      .build()
    return synchronized(transport.lock) {
      val current = generation === transport.generation(MESH_HUB_ORIGIN)
      if (current && transport.aliasFor(MESH_HUB_ORIGIN) != null) {
        client.newCall(request).also { transport.calls[id] = it }
      } else {
        null
      }
    }
  }

  private fun readReply(response: Response): FleetReply {
    if (!response.isSuccessful) {
      return when (response.code) {
        HTTP_UNAUTHORIZED, HTTP_FORBIDDEN -> FleetReply.Refused
        else -> FleetReply.Unavailable
      }
    }
    val body = response.peekBody(MAX_BODY_BYTES + 1).bytes()
    val machines = body.takeIf { it.size <= MAX_BODY_BYTES }?.let {
      parseFleet(it.toString(Charsets.UTF_8))
    }
    return if (machines == null) FleetReply.Unavailable else FleetReply.Fetched(machines)
  }

  override fun onStopped() {
    activeCall?.cancel()
  }

  private sealed interface FleetReply {
    data object Unavailable : FleetReply
    data object Refused : FleetReply
    data class Fetched(val machines: Map<String, FleetMachine>) : FleetReply
  }

  private companion object {
    const val TIMEOUT_SECONDS = 10L
    const val MAX_BODY_BYTES = 512L * 1024
  }
}
