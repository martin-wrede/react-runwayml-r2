export async function onRequest(context) {
  const { request, env } = context;

  // Standard CORS and method handling
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Runway-Version' } });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Check for all required environment variables, including the new KV binding
  if (!env.RUNWAYML_API_KEY || !env.R2_PUBLIC_URL || !env.IMAGE_BUCKET || !env.TASK_INFO_KV) {
    const errorMsg = 'CRITICAL FIX REQUIRED: Check Cloudflare project settings for API Key, R2 Public URL, R2 Bucket Binding, and KV Namespace Binding (TASK_INFO_KV).';
    console.error(errorMsg);
    return new Response(JSON.stringify({ success: false, error: errorMsg }), { status: 500 });
  }

  try {
    const contentType = request.headers.get('content-type') || '';

    // Handles the initial file upload to start generation
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const prompt = formData.get('prompt');
      const imageFile = formData.get('image');
      if (!prompt || !imageFile) throw new Error('Request is missing prompt or image file.');

      // 1. UPLOAD IMAGE TO R2
      const imageKey = `uploads/${Date.now()}-${imageFile.name}`;
      await env.IMAGE_BUCKET.put(imageKey, imageFile.stream(), { httpMetadata: { contentType: imageFile.type } });
      const imageUrlForRunway = `${env.R2_PUBLIC_URL}/${imageKey}`;
      
      // 2. PREPARE VIDEO KEY FOR R2
      // This creates a name like "videos/1678886400000-my-original-image.mp4"
      const videoKey = `videos/${Date.now()}-${imageFile.name.split('.').slice(0, -1).join('.') || imageFile.name}.mp4`;

      const config = {
        body: {
          model: 'gen3a_turbo',
          promptText: prompt,
          promptImage: imageUrlForRunway,
          seed: Math.floor(Math.random() * 4294967295),
          watermark: false,
          duration: 5,
          ratio: '1280:768'
        }
      };
      
      // 3. START GENERATION JOB
      const apiUrls = ['https://api.runwayml.com/v1/image_to_video', 'https://api.dev.runwayml.com/v1/image_to_video'];
      for (const apiUrl of apiUrls) {
        try {
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json' },
            body: JSON.stringify(config.body),
          });
          const data = await response.json();
          if (response.ok) {
            // 4. STORE TASK_ID -> VIDEO_KEY MAPPING IN KV
            await env.TASK_INFO_KV.put(data.id, JSON.stringify({ videoKey: videoKey, r2PublicUrl: env.R2_PUBLIC_URL }));
            
            return new Response(JSON.stringify({ success: true, taskId: data.id, status: data.status }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
          }
        } catch (fetchError) { /* Ignore and try next URL */ }
      }
      throw new Error(`All generation attempts failed.`);
    }
    
    // Handles subsequent status checks
    else if (contentType.includes('application/json')) {
      const { taskId, action } = await request.json();
      if (action !== 'status' || !taskId) throw new Error('Invalid status check request.');
      
      const apiUrls = ['https://api.runwayml.com/v1/tasks', 'https://api.dev.runwayml.com/v1/tasks'];
      for (const baseUrl of apiUrls) {
        try {
          const response = await fetch(`${baseUrl}/${taskId}`, { headers: { 'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`, 'X-Runway-Version': '2024-11-06' } });
          const data = await response.json();
          
          if (!response.ok) continue; // Try next API URL if this one fails

          // 5. IF JOB SUCCEEDED, STORE VIDEO IN R2
          if (data.status === 'SUCCEEDED' && data.output?.[0]) {
            const runwayVideoUrl = data.output[0];
            const taskInfo = await env.TASK_INFO_KV.get(taskId, { type: 'json' });

            if (!taskInfo || !taskInfo.videoKey) {
              throw new Error(`Could not find R2 destination key for task ${taskId}.`);
            }

            const videoResponse = await fetch(runwayVideoUrl);
            if (!videoResponse.ok) {
              throw new Error(`Failed to download generated video from Runway. Status: ${videoResponse.status}`);
            }

            // Upload the video stream to your R2 bucket
            await env.IMAGE_BUCKET.put(taskInfo.videoKey, videoResponse.body, {
              httpMetadata: { contentType: 'video/mp4' }
            });

            const finalVideoUrl = `${taskInfo.r2PublicUrl}/${taskInfo.videoKey}`;
            
            // Clean up the KV store entry (don't wait for it to finish)
            context.waitUntil(env.TASK_INFO_KV.delete(taskId));

            return new Response(JSON.stringify({ success: true, status: data.status, progress: data.progress, videoUrl: finalVideoUrl }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
          }

          // For other statuses (pending, running, etc.), just return the status
          return new Response(JSON.stringify({ success: true, status: data.status, progress: data.progress, videoUrl: data.output?.[0] || null }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        
        } catch (error) { /* Ignore and try next URL */ }
      }
      throw new Error(`Failed to check task status for task ID: ${taskId}`);
    } 
    else { throw new Error(`Invalid request content-type.`); }
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}