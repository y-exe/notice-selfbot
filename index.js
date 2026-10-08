require('dotenv').config();
require('./src/app')
    .start()
    .catch((error) => {
        console.error('起動に失敗しました:', error.message);
        process.exitCode = 1;
    });
