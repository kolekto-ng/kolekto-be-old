import fetch from "node-fetch";
import pkg from "@google-cloud/recaptcha-enterprise";
const { RecaptchaEnterpriseServiceClient } = pkg;


import dotenv from "dotenv";

dotenv.config();

/**
  * Create an assessment to analyze the risk of a UI action.
  *
  * projectID: Your Google Cloud Project ID.
  * recaptchaSiteKey: The reCAPTCHA key associated with the site/app
  * token: The generated token obtained from the client.
  * recaptchaAction: Action name corresponding to the token.
  */
export async function createAssessmentV3({
    // TODO: Replace the token and reCAPTCHA action variables before running the sample.
    projectID = "kolekto-app",
    recaptchaKey = "6LeWENorAAAAALS4O9P-c-x1e65yu-U5bt8XGp-t",
    token = "action-token",
    recaptchaAction = "action-name",
}) {
    // Create the reCAPTCHA client.
    // TODO: Cache the client generation code (recommended) or call client.close() before exiting the method.
    const client = new RecaptchaEnterpriseServiceClient();
    const projectPath = client.projectPath(projectID);

    // Build the assessment request.
    const request = ({
        assessment: {
            event: {
                token: token,
                siteKey: recaptchaKey,
            },
        },
        parent: projectPath,
    });

    const [response] = await client.createAssessment(request);

    // Check if the token is valid.
    if (!response.tokenProperties.valid) {
        console.log(`The CreateAssessment call failed because the token was: ${response.tokenProperties.invalidReason}`);
        return null;
    }

    // Check if the expected action was executed.
    // The `action` property is set by user client in the grecaptcha.enterprise.execute() method.
    if (response.tokenProperties.action === recaptchaAction) {
        // Get the risk score and the reason(s).
        // For more information on interpreting the assessment, see:
        // https://cloud.google.com/recaptcha-enterprise/docs/interpret-assessment
        console.log(`The reCAPTCHA score is: ${response.riskAnalysis.score}`);
        response.riskAnalysis.reasons.forEach((reason) => {
            console.log(reason);
        });

        return response.riskAnalysis.score;
    } else {
        console.log("The action attribute in your reCAPTCHA tag does not match the action you are expecting to score");
        return null;
    }
}

const client = new RecaptchaEnterpriseServiceClient();
const projectID = "kolekto-app"; // your GCP project ID

export async function verifyRecaptcha({ token, siteKey, expectedAction }) {
    const projectPath = client.projectPath(projectID);

    const request = {
        assessment: {
            event: {
                token,
                siteKey,
            },
        },
        parent: projectPath,
    };

    const [response] = await client.createAssessment(request);

    // 🔎 token validity
    if (!response.tokenProperties.valid) {
        console.log("Invalid token reason:", response.tokenProperties.invalidReason);
        return { success: false };
    }

    // 🔎 match the action for v3
    if (expectedAction && response.tokenProperties.action !== expectedAction) {
        console.log("Action mismatch");
        return { success: false };
    }

    // 🔎 v3 → return score
    if (response.riskAnalysis) {
        return {
            success: true,
            score: response.riskAnalysis.score,
            reasons: response.riskAnalysis.reasons,
        };
    }

    // 🔎 v2 → no score, just success
    return { success: true };
}
