import { handler } from './app.js';

// Simulate API Gateway v2 Lambda event for /health
const lambdaEvent = {
    rawPath: '/health',
    requestContext: {
        http: {
            method: 'GET'
        }
    },
    headers: {}
};

const lambdaContext = {
    awsRequestId: 'test-request-123'
};

(async () => {
    console.log('Testing serverless wrapper with Lambda event...\n');
    const response = await handler(lambdaEvent, lambdaContext);
    console.log('Lambda Response:', JSON.stringify(response, null, 2));
    process.exit(0);
})();
