package expo.modules.t3clientcertificates.stream

import android.os.Bundle
import android.os.IBinder
import android.os.Message
import android.os.Messenger

/**
 * Messages between the app process and the stream process. Commands go to [StreamService];
 * events come back to the `replyTo` messenger of the command that opened the session.
 */
internal object StreamProtocol {
  // Commands.
  const val OPEN = 1
  const val RESIZE = 2
  const val EVALUATE = 3
  const val CLOSE = 4

  // Events.
  const val SURFACE = 101
  const val MESSAGE = 102
  const val LOAD_ERROR = 103
  const val HTTP_ERROR = 104
  const val RENDER_GONE = 105

  const val SESSION = "session"
  const val ENVIRONMENT_URL = "environmentUrl"
  const val ALIAS = "alias"
  const val KEYSTORE_ALIAS = "keystoreAlias"
  const val CHAIN_PEM = "chainPem"
  const val DOCUMENT_FILE = "documentFile"
  const val BASE_URL = "baseUrl"
  const val HOST_TOKEN = "hostToken"
  const val DISPLAY = "display"
  const val WIDTH = "width"
  const val HEIGHT = "height"
  const val SCRIPT = "script"
  const val SURFACE_PACKAGE = "surfacePackage"
  const val DATA = "data"
  const val DESCRIPTION = "description"
  const val CODE = "code"
  const val URL = "url"
  const val STATUS = "status"
  const val DID_CRASH = "didCrash"

  /** Binder transactions share a 1 MB buffer; page messages are small JSON, anything else is dropped. */
  const val MAX_MESSAGE_CHARS = 200_000

  /** Documents travel as files so the script never has to fit in a transaction. */
  const val DOCUMENT_DIRECTORY = "t3-stream-documents"

  fun message(what: Int, session: String, reply: Messenger? = null, fill: Bundle.() -> Unit = {}) =
    Message.obtain(null, what).apply {
      replyTo = reply
      data = Bundle().apply {
        putString(SESSION, session)
        fill()
      }
    }
}

/** What the app process asks the stream process to open. */
@Suppress("LongParameterList") // A flat wire message, mirrored by the bundle keys.
internal class OpenRequest(
  val environmentUrl: String?,
  val alias: String?,
  /** The Keystore alias and certificate chain when [alias] is the enrolled identity. */
  val enrolled: StreamEnrolledIdentity?,
  val documentFile: String,
  val baseUrl: String,
  val hostToken: IBinder,
  val displayId: Int,
  val width: Int,
  val height: Int
) {
  fun toMessage(session: String, reply: Messenger) =
    StreamProtocol.message(StreamProtocol.OPEN, session, reply) {
      putString(StreamProtocol.ENVIRONMENT_URL, environmentUrl)
      putString(StreamProtocol.ALIAS, alias)
      putString(StreamProtocol.KEYSTORE_ALIAS, enrolled?.keystoreAlias)
      putString(StreamProtocol.CHAIN_PEM, enrolled?.chainPem)
      putString(StreamProtocol.DOCUMENT_FILE, documentFile)
      putString(StreamProtocol.BASE_URL, baseUrl)
      putBinder(StreamProtocol.HOST_TOKEN, hostToken)
      putInt(StreamProtocol.DISPLAY, displayId)
      putInt(StreamProtocol.WIDTH, width)
      putInt(StreamProtocol.HEIGHT, height)
    }

  companion object {
    private fun enrolledFrom(data: Bundle): StreamEnrolledIdentity? {
      val keystoreAlias = data.getString(StreamProtocol.KEYSTORE_ALIAS)
      val chainPem = data.getString(StreamProtocol.CHAIN_PEM)
      return keystoreAlias?.let { alias -> chainPem?.let { StreamEnrolledIdentity(alias, it) } }
    }

    fun from(data: Bundle): OpenRequest? {
      val hostToken = data.getBinder(StreamProtocol.HOST_TOKEN)
      val documentFile = data.getString(StreamProtocol.DOCUMENT_FILE)
      val baseUrl = data.getString(StreamProtocol.BASE_URL)
      return if (hostToken == null || documentFile == null || baseUrl == null) {
        null
      } else {
        OpenRequest(
          environmentUrl = data.getString(StreamProtocol.ENVIRONMENT_URL),
          alias = data.getString(StreamProtocol.ALIAS),
          enrolled = enrolledFrom(data),
          documentFile = documentFile,
          baseUrl = baseUrl,
          hostToken = hostToken,
          displayId = data.getInt(StreamProtocol.DISPLAY),
          width = data.getInt(StreamProtocol.WIDTH),
          height = data.getInt(StreamProtocol.HEIGHT)
        )
      }
    }
  }
}
