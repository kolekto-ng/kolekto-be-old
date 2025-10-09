import fetch from "node-fetch";

export const verifyRecaptcha = async (token, type = "v3") => {
    try {
        let secretKey;
        let minScore = 0.5;

        if (type === "v3") {
            secretKey = process.env.RECAPTCHA_V3_SECRET;
            minScore = 0.5; // Default minimum score for v3
        } else if (type === "v2") {
            secretKey = process.env.RECAPTCHA_V2_SECRET;
        } else {
            throw new Error("Invalid reCAPTCHA type. Must be 'v2' or 'v3'");
        }

        if (!secretKey) {
            throw new Error(`reCAPTCHA ${type} secret key not configured`);
        }

        const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${token}`;
        const response = await fetch(verifyUrl, { method: "POST" });
        const data = await response.json();

        if (!data.success) {
            return {
                success: false,
                error: "reCAPTCHA verification failed",
                errors: data["error-codes"] || []
            };
        }

        // For v3, check score
        if (type === "v3" && data.score < minScore) {
            return {
                success: false,
                error: `reCAPTCHA score too low: ${data.score} (minimum: ${minScore})`,
                score: data.score
            };
        }

        return {
            success: true,
            score: data.score || null,
            action: data.action || null
        };

    } catch (error) {
        console.error("reCAPTCHA verification error:", error);
        return {
            success: false,
            error: error.message
        };
    }
};