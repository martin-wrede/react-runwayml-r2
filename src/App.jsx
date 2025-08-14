import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [videoUrl, setVideoUrl] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);

  const pollIntervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const resetState = () => {
    setVideoUrl(null);
    setIsGenerating(false);
    setProgress(0);
    setStatus('');
    setError('');
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      if (!validTypes.includes(file.type)) {
        setError('Please select a valid image format (JPEG, PNG, WebP)');
        return;
      }
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (file.size > maxSize) {
        setError('The file is too large. Maximum 10MB allowed.');
        return;
      }
      setSelectedFile(file);
      setError('');
      setPreviewUrl(URL.createObjectURL(file));
    }
  };

  const removeFile = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  };

  const pollForStatus = (taskId) => {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const statusResponse = await fetch('/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, action: 'status' }),
        });
        if (!statusResponse.ok) return;
        const statusData = await statusResponse.json();
        if (!statusData.success) throw new Error(statusData.error || 'Failed to check status');

        setStatus(`Status: ${statusData.status}`);
        setProgress(statusData.progress || 0);

        if (statusData.status === 'SUCCEEDED') {
          setVideoUrl(statusData.videoUrl);
          setStatus('Video generation completed!');
          setIsGenerating(false);
          clearInterval(pollIntervalRef.current);
        } else if (statusData.status === 'FAILED') {
          throw new Error(statusData.failure?.reason || 'Video generation failed');
        }
      } catch (pollError) {
        setError(pollError.message);
        setIsGenerating(false);
        clearInterval(pollIntervalRef.current);
      }
    }, 4000);
  };

  const generateVideo = async () => {
    if (!selectedFile || !prompt.trim()) {
      setError('Please select an image and enter a prompt.');
      return;
    }
    
    resetState();
    setIsGenerating(true);
    setStatus('Uploading image and starting job...');

    try {
      const formData = new FormData();
      formData.append('prompt', prompt);
      formData.append('image', selectedFile);

      const response = await fetch('/ai', { method: 'POST', body: formData });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to start video generation');
      }

      setStatus('Video generation started, processing...');
      pollForStatus(data.taskId);

    } catch (err) {
      setError(err.message);
      setIsGenerating(false);
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '600px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <h2>Generate Video with RunwayML</h2>
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', marginBottom: '5px' }}>Video Prompt:</label>
        <input type="text" placeholder="e.g., 'camera slowly zooms in'" value={prompt} onChange={e => setPrompt(e.target.value)} style={{ width: '100%', padding: '10px', fontSize: '16px', boxSizing: 'border-box' }} />
      </div>
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', marginBottom: '5px' }}>Source Image:</label>
        <input id="fileInput" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFileSelect} style={{ width: '100%' }} />
      </div>
      {previewUrl && (
        <div style={{ marginBottom: '20px', position: 'relative', display: 'inline-block' }}>
          <img src={previewUrl} alt="Preview" style={{ maxWidth: '300px', maxHeight: '200px', border: '1px solid #ddd' }} />
          <button onClick={removeFile} style={{ position: 'absolute', top: '5px', right: '5px', background: 'rgba(255,0,0,0.7)', color: 'white', border: 'none', borderRadius: '50%', width: '25px', height: '25px', cursor: 'pointer' }}>×</button>
        </div>
      )}
      <button onClick={generateVideo} disabled={isGenerating || !selectedFile || !prompt.trim()} style={{ padding: '10px 20px', fontSize: '16px', backgroundColor: (isGenerating || !selectedFile || !prompt.trim()) ? '#ccc' : '#007bff', color: 'white', border: 'none', cursor: 'pointer' }}>
        {isGenerating ? 'Generating...' : 'Generate Video'}
      </button>
      {status && (
        <div style={{ marginTop: '20px', padding: '10px', backgroundColor: '#f0f0f0' }}>
          <p>{status}</p>
          {isGenerating && progress > 0 && (
            <div style={{ backgroundColor: '#ddd' }}><div style={{ width: `${progress}%`, height: '20px', backgroundColor: '#007bff', transition: 'width 0.5s ease' }} /></div>
          )}
        </div>
      )}
      {error && (<div style={{ marginTop: '20px', padding: '10px', backgroundColor: '#ffebee', color: '#c62828' }}>Error: {error}</div>)}
      {videoUrl && (
        <div style={{ marginTop: '20px' }}>
          <h3>Generated Video:</h3>
          <video controls muted autoPlay loop style={{ width: '100%', maxWidth: '500px' }} src={videoUrl}>Your browser does not support the video tag.</video>
        </div>
      )}
      <div style={{ marginTop: '30px', fontSize: '14px', color: '#666' }}>
        <p><strong>Model:</strong> gen3a_turbo</p>
        <p><strong>Duration:</strong> 5 seconds</p>
      </div>
    </div>
  );
}