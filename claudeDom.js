console.log("Expiring Photos Script v2 Loaded");

(function () {
  const EXPIRY_TIME_SECONDS = 3;
  let trackedMessages = new Map();

  // Inject script into page context to access Telegram's APIs
  function injectPageScript() {
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        console.log("Injected script running in page context");
        
        // Store original methods
        const originalFetch = window.fetch;
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;
        
        // Track outgoing photos
        let photoUploadTimestamps = [];
        
        // Intercept fetch for file uploads
        window.fetch = function(...args) {
          const url = args[0];
          if (typeof url === 'string' && url.includes('upload')) {
            console.log('Photo upload detected via fetch');
            photoUploadTimestamps.push(Date.now());
          }
          return originalFetch.apply(this, args);
        };
        
        // Watch for new messages in DOM
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1 && node.classList && node.classList.contains('message')) {
                const msgId = node.getAttribute('data-message-id');
                const hasPhoto = node.querySelector('.photo, .media-photo, [class*="photo"]');
                
                if (msgId && hasPhoto) {
                  const now = Date.now();
                  // Check if this photo was uploaded in the last 5 seconds
                  const recentUpload = photoUploadTimestamps.find(ts => (now - ts) < 5000);
                  
                  if (recentUpload) {
                    console.log('New photo message detected:', msgId);
                    window.postMessage({
                      type: 'TELEGRAM_PHOTO_SENT',
                      msgId: parseInt(msgId),
                      timestamp: now,
                      expireAt: now + (${EXPIRY_TIME_SECONDS} * 1000)
                    }, '*');
                    
                    // Remove used timestamp
                    photoUploadTimestamps = photoUploadTimestamps.filter(ts => ts !== recentUpload);
                  }
                }
              }
            });
          });
        });
        
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
        
        // Clean old timestamps
        setInterval(() => {
          const now = Date.now();
          photoUploadTimestamps = photoUploadTimestamps.filter(ts => (now - ts) < 10000);
        }, 5000);
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // Listen for messages from injected script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data.type === "TELEGRAM_PHOTO_SENT") {
      const { msgId, expireAt } = event.data;
      console.log(
        `Tracking message ${msgId} for deletion at`,
        new Date(expireAt)
      );
      trackedMessages.set(msgId, expireAt);
    }
  });

  // Check for expired messages
  setInterval(() => {
    const now = Date.now();

    trackedMessages.forEach((expireAt, msgId) => {
      if (now >= expireAt) {
        console.log(`Attempting to delete message ${msgId}`);
        deleteMessage(msgId);
        trackedMessages.delete(msgId);
      }
    });
  }, 1000);

  // Delete message by simulating user actions
  function deleteMessage(msgId) {
    const messageElement = document.querySelector(
      `[data-message-id="${msgId}"]`
    );

    if (!messageElement) {
      console.warn(`Message ${msgId} not found in DOM`);
      return;
    }

    try {
      // Method 1: Try right-click context menu
      messageElement.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
        })
      );

      // Wait for context menu to appear
      setTimeout(() => {
        const deleteButton = Array.from(
          document.querySelectorAll(".btn-menu-item, .menu-item")
        ).find((el) => el.textContent.toLowerCase().includes("delete"));

        if (deleteButton) {
          deleteButton.click();
          console.log(`Clicked delete for message ${msgId}`);

          // Confirm deletion
          setTimeout(() => {
            const confirmButton = Array.from(
              document.querySelectorAll("button, .btn")
            ).find(
              (el) =>
                el.textContent.toLowerCase().includes("delete") ||
                el.textContent.toLowerCase().includes("yes")
            );
            if (confirmButton) {
              confirmButton.click();
              console.log(`Confirmed deletion for message ${msgId}`);
            }
          }, 200);
        }
      }, 200);
    } catch (error) {
      console.error(`Error deleting message ${msgId}:`, error);
    }
  }

  // Initialize
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectPageScript);
  } else {
    injectPageScript();
  }
})();
