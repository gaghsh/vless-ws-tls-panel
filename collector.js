// Traffic collection runs inside server.js so user data has one writer. This file
// remains as a helpful migration message for older deployment instructions.
console.error('The standalone collector is no longer used. Start the panel with: npm start');
process.exitCode = 1;
