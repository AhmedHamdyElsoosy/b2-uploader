const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
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

    await axios.post(uploadUrl, fileBuffer, {
      headers: {
        Authorization: uploadAuthToken,
        'X-Bz-File-Name': encodeURIComponent(file.originalname),
        'Content-Type': 'b2/x-auto',
        'X-Bz-Content-Sha1': 'do_not_verify'
      }
    });

    fs.unlinkSync(file.path); // حذف الملف المؤقت

    const fileUrl = `${auth.downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(file.originalname)}`;
    res.json({ success: true, url: fileUrl });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Route تحميل آمن للملفات
app.get('/download', async (req, res) => {
  try {
    const fileName = req.query.file;
    if (!fileName) return res.status(400).send('⚠️ اسم الملف مفقود.');

    const auth = await authorizeB2();
    const fileUrl = `${auth.downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(fileName)}`;

    const fileRes = await axios.get(fileUrl, { responseType: 'stream' });

    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fileName)}"`);
    fileRes.data.pipe(res);
  } catch (err) {
    console.error('❌ Error downloading file:', err.message);
    res.status(500).send('❌ حصل خطأ أثناء تحميل الملف.');
  }
});

// ✅ Route نسخ الملف باسم جديد ثم حذف النسخة الأصلية
app.post('/copy-contract', async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).send('❌ oldName و newName مطلوبين');

    const auth = await authorizeB2();

    // تحميل الملف القديم
    const oldFileUrl = `${auth.downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(oldName)}`;
    const fileRes = await axios.get(oldFileUrl, { responseType: 'arraybuffer' });

    // رفع باسم جديد
    const uploadUrlRes = await axios.post(
      `${auth.apiUrl}/b2api/v2/b2_get_upload_url`,
      { bucketId: B2_BUCKET_ID },
      { headers: { Authorization: auth.authorizationToken } }
    );

    const uploadUrl = uploadUrlRes.data.uploadUrl;
    const uploadAuthToken = uploadUrlRes.data.authorizationToken;

    await axios.post(uploadUrl, fileRes.data, {
      headers: {
        Authorization: uploadAuthToken,
        'X-Bz-File-Name': encodeURIComponent(newName),
        'Content-Type': 'b2/x-auto',
        'X-Bz-Content-Sha1': 'do_not_verify'
      }
    });

    // الحصول على fileId وحذف النسخة القديمة
    const listRes = await axios.post(
      `${auth.apiUrl}/b2api/v2/b2_list_file_names`,
      {
        bucketId: B2_BUCKET_ID,
        prefix: oldName,
        maxFileCount: 1
      },
      {
        headers: { Authorization: auth.authorizationToken }
      }
    );

    const files = listRes.data.files;
    if (files.length > 0) {
      const fileId = files[0].fileId;

      await axios.post(
        `${auth.apiUrl}/b2api/v2/b2_delete_file_version`,
        {
          fileName: oldName,
          fileId: fileId
        },
        {
          headers: { Authorization: auth.authorizationToken }
        }
      );

      console.log(`🗑️ Deleted old file: ${oldName}`);
    } else {
      console.warn(`⚠️ Could not find old file: ${oldName}`);
    }

    res.status(200).send('✅ File copied with new name and old one deleted');
  } catch (err) {
    console.error('❌ Error in /copy-contract:', err.response?.data || err.message);
    res.status(500).send('❌ Error copying and deleting file');
  }
});

app.listen(3000, () => {
  console.log('✅ Server running on http://localhost:3000');
});
