import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 1:1 port of NiceIdCryptoUtils.decrypt (NiceIdCryptoUtils.kt lines 35-81).
 *
 * <p>Usage:
 * {@code java tools/jvm/ClientDecryptVerify.java <ticket> <iterators> <transactionId> <encData> <integrityValue>}
 */
public class ClientDecryptVerify {

    static final int GCM_TAG_LENGTH_BITS = 128;
    static final int GCM_IV_LENGTH_BYTES = 16;
    static final int KEY_LENGTH_BITS = 512;

    public static void main(String[] args) throws Exception {
        if (args.length != 5) {
            System.err.println("Usage: ClientDecryptVerify <ticket> <iterators> <transactionId> <encData> <integrityValue>");
            System.exit(1);
        }
        String ticket = args[0];
        int iterators;
        try {
            iterators = Integer.parseInt(args[1]);
        } catch (NumberFormatException e) {
            System.err.println("decrypt failure: invalid iterators: " + args[1]);
            System.exit(1);
            return;
        }
        String transactionId = args[2];
        String encData = args[3];
        String integrityValue = args[4];

        try {
            System.out.println(decrypt(ticket, iterators, transactionId, encData, integrityValue));
        } catch (IntegrityException e) {
            System.err.println("integrity error: " + e.getMessage());
            System.exit(1);
        } catch (Exception e) {
            System.err.println("decrypt failure: " + e.getMessage());
            System.exit(1);
        }
    }

    static String decrypt(String ticket, int iterators, String transactionId, String encData,
            String integrityValue) throws Exception {
        String keyString = kdfValue(ticket, transactionId, iterators);

        String hmacKey = keyString.substring(48, 80);
        String moduleIntegrityValue = getSha256MacBase64Value(encData, hmacKey);
        if (!moduleIntegrityValue.equals(integrityValue)) {
            throw new IntegrityException("\ubaa8\ub4c8 \ub0b4 \uc704\ubcc0\uc870 \ub370\uc774\ud130 \uac80\uc99d\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.");
        }

        byte[] keyBytes = keyString.substring(0, 32).getBytes(StandardCharsets.UTF_8);
        return getAesGcmDec(keyBytes, encData);
    }

    static String kdfValue(String ticket, String transactionId, int iterators) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(ticket.toCharArray(),
                transactionId.getBytes(StandardCharsets.UTF_8), iterators, KEY_LENGTH_BITS);
        SecretKeyFactory skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
        return Base64.getUrlEncoder().withoutPadding().encodeToString(skf.generateSecret(spec).getEncoded());
    }

    static String getSha256MacBase64Value(String value, String hmacKey) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(hmacKey.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] hashValue = mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(hashValue);
    }

    static String getAesGcmDec(byte[] key, String base64Enc) throws Exception {
        byte[] cipherEnc = Base64.getUrlDecoder().decode(base64Enc);
        if (cipherEnc.length < GCM_IV_LENGTH_BYTES) {
            throw new IllegalArgumentException("encData too short");
        }
        byte[] iv = Arrays.copyOfRange(cipherEnc, 0, GCM_IV_LENGTH_BYTES);
        byte[] cipherText = Arrays.copyOfRange(cipherEnc, GCM_IV_LENGTH_BYTES, cipherEnc.length);
        SecretKey secureKey = new SecretKeySpec(key, "AES");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, secureKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
        return new String(c.doFinal(cipherText), StandardCharsets.UTF_8);
    }

    static final class IntegrityException extends Exception {
        IntegrityException(String message) {
            super(message);
        }
    }
}
