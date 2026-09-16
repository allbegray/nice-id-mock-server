import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Golden-vector generator for the nice-id mock server.
 *
 * Mirrors NiceIdCryptoUtils (kdf/hmac/aes-gcm layout) with a FIXED IV
 * [0x00..0x0F] so two runs are byte-identical. Single-file launch:
 * {@code java tools/jvm/GenGoldenVectors.java}
 */
public class GenGoldenVectors {

    static final String TICKET = "UzEyMDI1MTExMzA5NTQ0MjI3NDE1Njc3QTM0RDBBRUZEMjI5MzUzQzEz";
    static final int ITERATORS = 66;
    static final String TRANSACTION_ID = "UzE0MUQyNkFDOEQ3NzYyMDIwMjUxMTEzMTAwMjM3MzM4OTQ5QUMwMkU";
    static final String PLAINTEXT = "{\"name\":\"\ud64d\uae38\ub3d9\",\"birthdate\":\"19000208\",\"gender\":\"1\",\"national_info\":\"0\",\"ci\":\"CI\uac12\",\"di\":\"DI\uac12\",\"mobile_co\":\"2\",\"mobile_no\":\"01012345678\"}";

    public static void main(String[] args) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(
                TICKET.toCharArray(),
                TRANSACTION_ID.getBytes(StandardCharsets.UTF_8),
                ITERATORS,
                512);
        SecretKeyFactory skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
        byte[] keyBytes64 = skf.generateSecret(spec).getEncoded();
        String keyString = Base64.getUrlEncoder().withoutPadding().encodeToString(keyBytes64);

        byte[] aesKey = keyString.substring(0, 32).getBytes(StandardCharsets.UTF_8);
        String hmacKey = keyString.substring(48, 80);

        byte[] iv = new byte[16];
        for (int i = 0; i < 16; i++) {
            iv[i] = (byte) i;
        }

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(aesKey, "AES"), new GCMParameterSpec(128, iv));
        byte[] ct = cipher.doFinal(PLAINTEXT.getBytes(StandardCharsets.UTF_8));

        byte[] encBytes = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, encBytes, 0, iv.length);
        System.arraycopy(ct, 0, encBytes, iv.length, ct.length);
        String encData = Base64.getUrlEncoder().withoutPadding().encodeToString(encBytes);

        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(hmacKey.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String integrityValue = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(encData.getBytes(StandardCharsets.UTF_8)));

        System.out.println("{\"kdfValue\":\"" + keyString
                + "\",\"encData\":\"" + encData
                + "\",\"integrityValue\":\"" + integrityValue + "\"}");
    }
}
