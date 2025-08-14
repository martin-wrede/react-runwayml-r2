export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Runway-Version' } });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (!env.RUNWAYML_API_KEY || !env.R2_PUBLIC_URL || !env.IMAGE_BUCKET) {
    const errorMsg = 'CRITICAL FIX REQUIRED: Check Cloudflare project settings for API Key, R2 Public URL, and R2 Bucket Binding.';
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

      const key = `uploads/${Date.now()}-${imageFile.name}`;
      await env.IMAGE_BUCKET.put(key, imageFile.stream(), { httpMetadata: { contentType: imageFile.type } });
      const imageUrlForRunway = `${env.R2_PUBLIC_URL}/${key}`;
      
      const config = {
        body: {
          model: 'gen3a_turbo',
          promptText: prompt,
          promptImage: imageUrlForRunway,
          seed: Math.floor(Math.random() * 4294967295),
          watermark: false,
          duration: 5, // Set to 5 seconds as you discovered
          ratio: '1280:768'
        }
      };

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
          if (response.ok) {
            return new Response(JSON.stringify({ success: true, status: data.status, progress: data.progress, videoUrl: data.output?.[0] || null }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
          }
        } catch (error) { /* Ignore and try next URL */ }
      }
      throw new Error(`Failed to check task status for task ID: ${taskId}`);
    } 
    else { throw new Error(`Invalid request content-type.`); }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}