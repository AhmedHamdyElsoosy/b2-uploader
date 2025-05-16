const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
const upload = multer({ dest: 'uploads/' });

const {
  B2_KEY_ID,
  B2_APP_KEY,
  B2_BUCKET_ID,
  B2_BUCKET_NAME
} = process.env;

let cachedAuth = null;

async function authorizeB2() {
  if (cachedAuth) return cachedAuth;

  const credentials = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
  const response = await axios.get('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: `Basic ${credentials}` }
  });

  cachedAuth = response.data;
  return cachedAuth;
}

// ✅ Route رفع الملفات
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const auth = await authorizeB2();

    const uploadUrlRes = await axios.post(
      `${auth.apiUrl}/b2api/v2/b2_get_upload_url`,
      { bucketId: B2_BUCKET_ID },
      { headers: { Authorization: auth.authorizationToken } }
    );

    const uploadUrl = uploadUrlRes.data.uploadUrl;
    const uploadAuthToken = uploadUrlRes.data.authorizationToken;

    const fileBuffer = fs.readFileSync(file.path);

    await axios.post(
      uploadUrl,
      fileBuffer,
      {
        headers: {
          Authorization: uploadAuthToken,
          'X-Bz-File-Name': encodeURIComponent(file.originalname),
          'Content-Type': 'b2/x-auto',
          'X-Bz-Content-Sha1': 'do_not_verify'
        }
      }
    );

    fs.unlinkSync(file.path); // حذف الملف المؤقت

    const fileUrl = `${auth.downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(file.originalname)}`;

    res.json({ success: true, url: fileUrl });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Route تحميل آمن للملفات
app.get('/check', async (req, res) => {
  try {
    const fileName = req.query.file;
    if (!fileName) return res.status(400).send('No file specified');

    const auth = await authorizeB2();
    const fileUrl = `${auth.downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(fileName)}`;

    const headRes = await axios.head(fileUrl, {
      headers: { Authorization: auth.authorizationToken }
    });

    if (headRes.status === 200) {
      res.status(200).send('File exists');
    } else {
      res.status(404).send('File not found');
    }

  } catch (err) {
    if (err.response && err.response.status === 404) {
      res.status(404).send('File not found');
    } else {
      console.error('Error in /check:', err.message);
      res.status(500).send('Error checking file');
    }
  }
});

app.listen(3000, () => {
  console.log('✅ Server running on http://localhost:3000');
});
