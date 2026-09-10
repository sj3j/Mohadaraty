export async function forceDownload(url: string, filename: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Network response was not ok');
    const blob = await response.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(objectUrl);
    }, 100);
  } catch (error) {
    console.error('Download failed via fetch, falling back to direct link:', error);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

export function getYoutubeEmbedUrl(url: string): string {
  if (!url) return '';
  if (url.includes('embed/')) return url;
  
  try {
    let parsedUrl = url;
    if (!parsedUrl.startsWith('http')) {
      parsedUrl = 'https://' + parsedUrl;
    }
    
    const urlObj = new URL(parsedUrl);
    const videoId = urlObj.searchParams.get('v');
    const playlistId = urlObj.searchParams.get('list');
    
    if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be')) {
       if (urlObj.pathname === '/playlist' && playlistId) {
         return `https://www.youtube.com/embed/videoseries?list=${playlistId}`;
       }
       if (videoId) {
         let embedUrl = `https://www.youtube.com/embed/${videoId}`;
         if (playlistId) {
           embedUrl += `?list=${playlistId}`;
         }
         return embedUrl;
       }
       if (urlObj.hostname === 'youtu.be') {
         const path = urlObj.pathname.slice(1);
         if (path) {
           let embedUrl = `https://www.youtube.com/embed/${path}`;
           if (playlistId) {
             embedUrl += `?list=${playlistId}`;
           }
           return embedUrl;
         }
       }
    }
  } catch (e) {
    console.warn("Could not parse YouTube URL", e);
  }
  
  let processed = url.replace('watch?v=', 'embed/').replace('youtu.be/', 'youtube.com/embed/');
  processed = processed.replace('&list=', '?list=');
  return processed;
}
