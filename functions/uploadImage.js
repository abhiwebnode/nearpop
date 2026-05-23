// ╔══════════════════════════════════════════════════════════════════╗
// ║  functions/uploadImage.js - Secure Image Upload Function         ║
// ║  PRODUCTION-READY: Server-side image processing & upload          ║
// ║  ✅ API key hidden, rate limiting, validation, optimization       ║
// ║  ✅ FIRESTORE VERSION - No Realtime Database needed               ║
// ║  ✅ ENVIRONMENT VARIABLES - Modern Firebase approach              ║
// ╚══════════════════════════════════════════════════════════════════╝


const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const sharp = require('sharp');

// Initialize Firebase Admin (if not already initialized)
if (!admin.apps.length) {
  admin.initializeApp();
}

// ═══════════════════════════════════════════════════════════════════
// SECURE IMAGE UPLOAD CLOUD FUNCTION
// ═══════════════════════════════════════════════════════════════════
exports.uploadListingImage = functions
  .region('asia-south1')
  .runWith({
    memory: '1GB',
    timeoutSeconds: 60,
    maxInstances: 50
  })
  .https.onCall(async (data, context) => {
    console.log('[UploadImage] Function invoked');

    // ═══════════════════════════════════════════════════════════════
    // STEP 1: AUTHENTICATION CHECK
    // ═══════════════════════════════════════════════════════════════
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Authentication required to upload images'
      );
    }

    const userId = context.auth.uid;
    const userEmail = context.auth.token.email || 'unknown';

    console.log('[UploadImage] User:', userId);

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: RATE LIMITING (5 uploads per hour per user)
    // ✅ USING FIRESTORE (not Realtime Database)
    // ═══════════════════════════════════════════════════════════════
    try {
      const db = admin.firestore();
      const rateLimitRef = db.collection('rate_limits').doc(userId);
      const rateLimitSnap = await rateLimitRef.get();
      
      // Get existing uploads or empty array
      const rateLimitData = rateLimitSnap.exists ? rateLimitSnap.data() : {};
      const uploads = rateLimitData.uploads || [];

      // Clean old uploads (older than 1 hour)
      const oneHourAgo = Date.now() - 3600000;
      const recentUploads = uploads.filter(timestamp => timestamp > oneHourAgo);

      if (recentUploads.length >= 5) {
        throw new functions.https.HttpsError(
          'resource-exhausted',
          'Upload limit reached. Maximum 5 images per hour. Please wait.'
        );
      }

      // Add current timestamp
      recentUploads.push(Date.now());
      
      // Update Firestore
      await rateLimitRef.set({
        uploads: recentUploads,
        lastUpload: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log('[UploadImage] Rate limit check passed:', recentUploads.length, '/5');
    } catch (error) {
      if (error.code === 'resource-exhausted') throw error;
      console.warn('[UploadImage] Rate limit check failed:', error);
      // Continue on error (fail-open for rate limiting)
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: INPUT VALIDATION
    // ═══════════════════════════════════════════════════════════════
    const { imageBase64 } = data;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Image data is required'
      );
    }

    // Check if it's a valid data URL
    if (!imageBase64.startsWith('data:image/')) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Invalid image format. Must be a valid image data URL'
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: EXTRACT AND VALIDATE IMAGE DATA
    // ═══════════════════════════════════════════════════════════════
    let imageBuffer;
    let originalFormat;

    try {
      // Extract base64 data (remove data:image/xxx;base64, prefix)
      const matches = imageBase64.match(/^data:image\/([a-z]+);base64,(.+)$/i);
      
      if (!matches || matches.length !== 3) {
        throw new Error('Invalid image data URL format');
      }

      originalFormat = matches[1].toLowerCase();
      const base64Data = matches[2];

      // Validate format
      const allowedFormats = ['jpeg', 'jpg', 'png', 'webp'];
      if (!allowedFormats.includes(originalFormat)) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Invalid image format. Only JPEG, PNG, and WebP are allowed'
        );
      }

      // Decode base64
      imageBuffer = Buffer.from(base64Data, 'base64');

      console.log('[UploadImage] Image decoded:', {
        format: originalFormat,
        size: imageBuffer.length,
        sizeMB: (imageBuffer.length / 1024 / 1024).toFixed(2)
      });

    } catch (error) {
      console.error('[UploadImage] Decode error:', error);
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Failed to decode image data: ' + error.message
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: SIZE VALIDATION (Max 10MB)
    // ═══════════════════════════════════════════════════════════════
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (imageBuffer.length > maxSize) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        `Image too large. Maximum size is 10MB. Your image is ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 6: IMAGE VALIDATION & PROCESSING WITH SHARP
    // ═══════════════════════════════════════════════════════════════
    let processedBuffer;
    let metadata;

    try {
      // Get image metadata
      metadata = await sharp(imageBuffer).metadata();

      console.log('[UploadImage] Image metadata:', {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        channels: metadata.channels
      });

      // Validate dimensions (max 4000x4000)
      if (metadata.width > 4000 || metadata.height > 4000) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          `Image dimensions too large. Maximum 4000x4000 pixels. Your image is ${metadata.width}x${metadata.height}`
        );
      }

      // Validate format matches what was declared
      const declaredFormat = originalFormat === 'jpg' ? 'jpeg' : originalFormat;
      if (metadata.format !== declaredFormat) {
        console.warn('[UploadImage] Format mismatch:', {
          declared: declaredFormat,
          actual: metadata.format
        });
        // Continue but use actual format
      }

      // ═══════════════════════════════════════════════════════════
      // STEP 7: OPTIMIZE IMAGE
      // ═══════════════════════════════════════════════════════════
      console.log('[UploadImage] Optimizing image...');

      processedBuffer = await sharp(imageBuffer)
        .resize(1200, 1200, {
          fit: 'inside',
          withoutEnlargement: true,
          kernel: 'lanczos3'
        })
        .jpeg({
          quality: 85,
          progressive: true,
          mozjpeg: true
        })
        .toBuffer();

      console.log('[UploadImage] Image optimized:', {
        originalSize: (imageBuffer.length / 1024).toFixed(2) + ' KB',
        optimizedSize: (processedBuffer.length / 1024).toFixed(2) + ' KB',
        reduction: ((1 - processedBuffer.length / imageBuffer.length) * 100).toFixed(1) + '%'
      });

    } catch (error) {
      console.error('[UploadImage] Processing error:', error);
      throw new functions.https.HttpsError(
        'internal',
        'Failed to process image: ' + error.message
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 8: UPLOAD TO IMGBB (API KEY SECURE ON SERVER)
    // ═══════════════════════════════════════════════════════════════
    try {
      console.log('[UploadImage] Uploading to ImgBB...');

      // ✅ API KEY SECURE: Stored in environment variables
      const imgbbApiKey = process.env.IMGBB_API_KEY;

      if (!imgbbApiKey) {
        console.error('[UploadImage] ImgBB API key not configured');
        throw new functions.https.HttpsError(
          'internal',
          'Image upload service not configured. Please contact support.'
        );
      }

      // Convert to base64 for ImgBB
      const optimizedBase64 = processedBuffer.toString('base64');

      // Prepare form data
      const formData = new URLSearchParams();
      formData.append('image', optimizedBase64);
      formData.append('expiration', '15552000'); // 180 days (6 months)
      formData.append('name', `nearpop_${userId}_${Date.now()}`);

      // Upload to ImgBB
      const uploadResponse = await fetch(
        `https://api.imgbb.com/1/upload?key=${imgbbApiKey}`,
        {
          method: 'POST',
          body: formData,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const uploadResult = await uploadResponse.json();

      if (!uploadResult.success) {
        console.error('[UploadImage] ImgBB upload failed:', uploadResult);
        throw new Error('ImgBB upload failed: ' + JSON.stringify(uploadResult));
      }

      console.log('[UploadImage] ImgBB upload successful:', {
        id: uploadResult.data.id,
        url: uploadResult.data.url,
        size: uploadResult.data.size
      });

      // ═══════════════════════════════════════════════════════════
      // STEP 9: LOG UPLOAD FOR AUDIT TRAIL (Using Firestore)
      // ═══════════════════════════════════════════════════════════
      try {
        await admin.firestore().collection('upload_logs').add({
          userId,
          userEmail,
          imageId: uploadResult.data.id,
          imageUrl: uploadResult.data.url,
          thumbnailUrl: uploadResult.data.thumb?.url || uploadResult.data.url,
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
          originalSize: imageBuffer.length,
          optimizedSize: processedBuffer.length,
          dimensions: `${metadata.width}x${metadata.height}`,
          originalFormat: originalFormat,
          outputFormat: 'jpeg'
        });

        console.log('[UploadImage] Upload logged to Firestore');
      } catch (logError) {
        console.warn('[UploadImage] Failed to log upload:', logError);
        // Don't fail the function if logging fails
      }

      // ═══════════════════════════════════════════════════════════
      // STEP 10: RETURN SUCCESS RESPONSE
      // ═══════════════════════════════════════════════════════════
      return {
        success: true,
        imageUrl: uploadResult.data.url,
        thumbnailUrl: uploadResult.data.thumb?.url || uploadResult.data.url,
        deleteUrl: uploadResult.data.delete_url,
        imageId: uploadResult.data.id,
        metadata: {
          originalSize: imageBuffer.length,
          optimizedSize: processedBuffer.length,
          dimensions: `${metadata.width}x${metadata.height}`,
          format: 'jpeg'
        }
      };

    } catch (error) {
      console.error('[UploadImage] Upload error:', error);
      
      // Handle specific errors
      if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
        throw new functions.https.HttpsError(
          'unavailable',
          'Image upload service temporarily unavailable. Please try again.'
        );
      }

      throw new functions.https.HttpsError(
        'internal',
        'Failed to upload image: ' + error.message
      );
    }
  });

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTION: DELETE IMAGE (Optional - for cleanup)
// ═══════════════════════════════════════════════════════════════════
exports.deleteListingImage = functions
  .region('asia-south1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
    }

    const { deleteUrl } = data;

    if (!deleteUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'Delete URL required');
    }

    try {
      // Call ImgBB delete endpoint
      const response = await fetch(deleteUrl);
      
      if (!response.ok) {
        throw new Error('Delete request failed');
      }

      console.log('[DeleteImage] Image deleted successfully');

      return { success: true };
    } catch (error) {
      console.error('[DeleteImage] Delete error:', error);
      throw new functions.https.HttpsError('internal', 'Failed to delete image');
    }
  });
