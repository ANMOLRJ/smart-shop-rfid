// Vercel/Next.js API route adapter for the existing Express API.
// The Express app handles JSON parsing, CORS, GET/POST and all action dispatching.
const app = require('../../api/index.js');

// Disable Next.js's default body parser because Express parses the body itself.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default app;
