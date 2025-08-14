// Helper function to trigger the upscale process
async function triggerUpscale(taskId, env) {
  const apiUrl = 'https://api.runwayml.com/v1/tasks'; // Upscale uses the same base URL
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`,
      'X-Runway-Version': '2024-11-06',
      'Content-Type': 'application/json'
    },
    // The body specifies the task to upscale
    body: JSON.stringify({ task_id: taskId, action: 'upscale' }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to start upscale task.');
  }
  return data; // Returns the new task object for the upscale job
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Runway-Version' } });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (!env.RUNWAYML_API_KEY || !env.R2_PUBLIC_URL || !env.IMAGE_BUCKET || !env.TASK_INFO_KV) {
    const errorMsg = 'CRITICAL FIX REQUIRED: Check Cloudflare project settings for API Key, R2 Public URL, R2 Bucket Binding, and KV Namespace Binding (TASK_INFO_KV).';
    return new Response(JSON.stringify({ success: false, error: errorMsg }), { status: 500 });
  }

  try {
    const contentType = request.headers.get('content-type') || '';

    // Handles the initial file upload
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const prompt = formData.get('prompt');
      const imageFile = formData.get('image');
      const duration = parseInt(formData.get('duration') || '5', 10);
      const ratio = formData.get('ratio') || '1280:768';
      const upscale = formData.get('upscale') === 'true'; // Convert string to boolean

      if (!prompt || !imageFile) throw new Error('Request is missing prompt or image file.');

      const imageKey = `uploads/${Date.now()}-${imageFile.name}`;
      await env.IMAGE_BUCKET.put(imageKey, imageFile.stream(), { httpMetadata: { contentType: imageFile.type } });
      const imageUrlForRunway = `${env.R2_PUBLIC_URL}/${imageKey}`;
      
      const videoKey = `videos/${Date.now()}-${imageFile.name.split('.').slice(0, -1).join('.') || imageFile.name}${upscale ? '-4k' : ''}.mp4`;
      
      const config = {
          model: 'gen3a_turbo',
          promptText: prompt,
          promptImage: imageUrlForRunway,
          seed: Math.floor(Math.random() * 4294967295),
          watermark: false,
          duration: duration,
          ratio: ratio
      };
      
      const response = await fetch('https://api.runwayml.com/v1/image_to_video', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to start generation.');

      // Save upscale preference in KV store along with other info
      await env.TASK_INFO_KV.put(data.id, JSON.stringify({ videoKey: videoKey, r2PublicUrl: env.R2_PUBLIC_URL, upscale: upscale, originalTaskId: data.id }));
      
      return new Response(JSON.stringify({ success: true, taskId: data.id, status: data.status }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    
    // Handles subsequent status checks
    else if (contentType.includes('application/json')) {
      const { taskId, action } = await request.json();
      if (action !== 'status' || !taskId) throw new Error('Invalid status check request.');
      
      const response = await fetch(`https://api.runwayml.com/v1/tasks/${taskId}`, { headers: { 'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`, 'X-Runway-Version': '2024-11-06' } });
      const data = await response.json();
      
      if (!response.ok) throw new Error(`Failed to check task status. Reason: ${data.error || 'Unknown'}`);

      // LOGIC FOR HANDLING THE TWO-STEP UPSCALE PROCESS
      if (data.status === 'SUCCEEDED') {
        // Retrieve task info. We need to check KV by both the current task ID and the original task ID
        let taskInfo = await env.TASK_INFO_KV.get(taskId, { type: 'json' });
        if (!taskInfo) {
           taskInfo = await env.TASK_INFO_KV.get(data.source_task_id, { type: 'json' });
        }
        if (!taskInfo) throw new Error(`Could not find task info for task ID: ${taskId}`);

        // CASE 1: UPSCALE WAS REQUESTED AND THIS IS THE *FIRST* VIDEO FINISHING
        if (taskInfo.upscale && taskId === taskInfo.originalTaskId) {
            const upscaleTask = await triggerUpscale(taskId, env);
            // Store the new upscale task ID in KV, keeping the original data
            await env.TASK_INFO_KV.put(upscaleTask.id, JSON.stringify(taskInfo));
            // Let the user know the upscale has started
            return new Response(JSON.stringify({ success: true, status: "Upscaling to 4K...", progress: 50 }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }

        // CASE 2: NO UPSCALE or THE UPSCALE IS FINISHED. Save video to R2.
        const videoUrlToSave = data.output?.[0];
        if (!videoUrlToSave) throw new Error("Task succeeded but no video URL was found.");

        const videoResponse = await fetch(videoUrlToSave);
        if (!videoResponse.ok) throw new Error(`Failed to download video from Runway. Status: ${videoResponse.status}`);

        await env.IMAGE_BUCKET.put(taskInfo.videoKey, videoResponse.body, { httpMetadata: { contentType: 'video/mp4' } });
        const finalVideoUrl = `${taskInfo.r2PublicUrl}/${taskInfo.videoKey}`;
        
        // Clean up KV entries for both original and upscale tasks
        context.waitUntil(env.TASK_INFO_KV.delete(taskId));
        context.waitUntil(env.TASK_INFO_KV.delete(taskInfo.originalTaskId));

        return new Response(JSON.stringify({ success: true, status: data.status, progress: 100, videoUrl: finalVideoUrl }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }

      // For other statuses, just return the current status
      return new Response(JSON.stringify({ success: true, status: data.status, progress: data.progress, videoUrl: null }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } 
    else { throw new Error(`Invalid request content-type.`); }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}