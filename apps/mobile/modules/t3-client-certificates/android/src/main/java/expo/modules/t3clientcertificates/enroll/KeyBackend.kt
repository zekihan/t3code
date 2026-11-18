package expo.modules.t3clientcertificates.enroll

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec

/** Prefix of every Keystore alias the app creates, so unreferenced ones can be found and deleted. */
internal const val KEY_ALIAS_PREFIX = "t3mesh-device-"

internal enum class KeyProtection(val wire: String) {
  STRONGBOX("strongbox"),
  TEE("tee"),
  SOFTWARE("software"),
  UNKNOWN("unknown")
}

/** Where the device key lives. The Android Keystore in the app; a software key pair in tests. */
internal interface KeyBackend {
  /** A new EC P-256 key that cannot be exported, with a fresh public key. Never reuses an alias. */
  fun generate(alias: String): PublicKey

  fun privateKey(alias: String): PrivateKey?

  fun delete(alias: String)

  /** Every alias this backend holds, ours or not. */
  fun aliases(): List<String>

  fun protection(alias: String): KeyProtection

  /** True when the key's bytes can be read out of the backend. */
  fun exportable(alias: String): Boolean
}

private const val ANDROID_KEYSTORE = "AndroidKeyStore"

/**
 * The key is EC P-256 for signing, with `DIGEST_NONE` as well as `SHA-256`: the CSR is signed with
 * SHA256withECDSA, while Conscrypt and Chromium sign TLS handshakes with NONEwithECDSA over a hash
 * they computed. StrongBox is preferred where the device has it and falls back to the TEE.
 */
internal class AndroidKeystoreBackend(private val context: Context) : KeyBackend {
  private fun keyStore() = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  override fun generate(alias: String): PublicKey {
    val strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && hasStrongBox()
    if (strongBox) {
      try {
        return generate(alias, strongBox = true)
      } catch (_: ProviderException) {
        // StrongBoxUnavailableException is one: the device lists the feature but cannot use it.
      } catch (_: GeneralSecurityException) {
        // Some StrongBox implementations refuse DIGEST_NONE; the TEE accepts it.
      }
      delete(alias)
    }
    return generate(alias, strongBox = false)
  }

  private fun hasStrongBox() =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

  private fun generate(alias: String, strongBox: Boolean): PublicKey {
    val spec =
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
        .apply {
          if (strongBox &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
          ) {
            setIsStrongBoxBacked(true)
          }
        }
        .build()
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
    generator.initialize(spec)
    return generator.generateKeyPair().public
  }

  override fun privateKey(alias: String): PrivateKey? = keyStore().getKey(
    alias,
    null
  ) as? PrivateKey

  override fun delete(alias: String) {
    val store = keyStore()
    if (store.containsAlias(alias)) store.deleteEntry(alias)
  }

  override fun aliases(): List<String> = keyStore().aliases().toList()

  override fun exportable(alias: String) = privateKey(alias)?.encoded != null

  @Suppress("DEPRECATION") // isInsideSecureHardware is the only signal before Android 12.
  override fun protection(alias: String): KeyProtection {
    val key = privateKey(alias) ?: return KeyProtection.UNKNOWN
    return try {
      val info = KeyFactory.getInstance(
        key.algorithm,
        ANDROID_KEYSTORE
      ).getKeySpec(key, KeyInfo::class.java)
      when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
          when (info.securityLevel) {
            KeyProperties.SECURITY_LEVEL_STRONGBOX -> KeyProtection.STRONGBOX
            KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> KeyProtection.TEE
            else -> KeyProtection.SOFTWARE
          }
        info.isInsideSecureHardware -> KeyProtection.TEE
        else -> KeyProtection.SOFTWARE
      }
    } catch (_: GeneralSecurityException) {
      KeyProtection.UNKNOWN
    }
  }
}
