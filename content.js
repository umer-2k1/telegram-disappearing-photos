console.log("Telegram Expiring Photos - MTProto Version");

console.log("TG11212", {
  apiManager: !!window.apiManager,
  appMessagesManager: !!window.appMessagesManager,
  managers: !!window.managers,
  invokeApi: !!window.apiManager?.invokeApi,
  deleteMessages: !!window.appMessagesManager?.deleteMessages,
});

 console.log("🚀 Telegram Auto-Delete Extension v3");
 console.log("🚀 Telegram Auto-Delete Extension v3");

(function () {
  const EXPIRY_TIME_SECONDS = 3;
  
  // Inject into page context
  function injectScript() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        console.log("📱 Telegram Auto-Delete: Searching for APIs...");
        
        const EXPIRY_MS = ${EXPIRY_TIME_SECONDS * 1000};
        let pendingPhotos = new Map();
        let messageQueue = new Map();
        let apiFound = false;
        
        // Deep search for Telegram APIs
        function findTelegramAPIs() {
          const apis = {
            apiManager: null,
            appMessagesManager: null,
            deleteMethod: null,
            sendMethod: null
          };
          
          // Search in window
          Object.keys(window).forEach(key => {
            const obj = window[key];
            if (!obj || typeof obj !== 'object') return;
            
            // Look for API manager
            if (key.toLowerCase().includes('api') || key.toLowerCase().includes('manager')) {
              if (obj.invokeApi || obj.invoke || obj.call) {
                console.log("🔍 Found potential API:", key);
                apis.apiManager = obj;
              }
              
              if (obj.deleteMessages) {
                console.log("🔍 Found delete method in:", key);
                apis.appMessagesManager = obj;
              }
            }
            
            // Deep search in nested objects
            if (typeof obj === 'object') {
              Object.keys(obj).forEach(subKey => {
                if (subKey === 'apiManager' || subKey === 'appMessagesManager') {
                  console.log(\`🔍 Found \${subKey} in window.\${key}\`);
                  if (subKey === 'apiManager') apis.apiManager = obj[subKey];
                  if (subKey === 'appMessagesManager') apis.appMessagesManager = obj[subKey];
                }
              });
            }
          });
          
          // Check common locations
          const checkPaths = [
            'window.apiManager',
            'window.appMessagesManager',
            'window.managers?.appMessagesManager',
            'window.app?.managers?.appMessagesManager',
            'window.telegram?.apiManager',
            'window.MTProto',
            'window.mtproto'
          ];
          
          checkPaths.forEach(path => {
            try {
              const obj = eval(path);
              if (obj) console.log("✓ Found:", path);
            } catch(e) {}
          });
          
          return apis;
        }
        
        // Wait for APIs to load
        let checkCount = 0;
        const maxChecks = 60; // 30 seconds
        
        const apiChecker = setInterval(() => {
          checkCount++;
          
          const apis = findTelegramAPIs();
          
          if (apis.apiManager || apis.appMessagesManager) {
            clearInterval(apiChecker);
            apiFound = true;
            console.log("✅ Telegram APIs found!");
            setupHooks(apis);
          } else if (checkCount >= maxChecks) {
            clearInterval(apiChecker);
            console.error("❌ Could not find Telegram APIs after 30 seconds");
            console.log("💡 Available window objects:", Object.keys(window).filter(k => k.toLowerCase().includes('api') || k.toLowerCase().includes('manager') || k.toLowerCase().includes('telegram')));
            
            // Fallback: try DOM-based detection
            setupDOMFallback();
          } else if (checkCount % 10 === 0) {
            console.log(\`⏳ Still searching... (\${checkCount}/\${maxChecks})\`);
          }
        }, 500);
        
        function setupHooks(apis) {
          // Hook send method
          if (apis.apiManager?.invokeApi) {
            const originalInvoke = apis.apiManager.invokeApi;
            
            apis.apiManager.invokeApi = function(method, params, options) {
              // Detect photo upload
              if (method === 'messages.sendMedia' || method === 'messages.sendMessage') {
                const hasPhoto = params?.media?._?.includes('Photo') || 
                               params?.media?._?.includes('photo') ||
                               params?.file;
                
                if (hasPhoto) {
                  const randomId = params?.random_id || params?.message?.random_id || Date.now();
                  console.log("📤 Photo send detected, tracking:", randomId);
                  
                  pendingPhotos.set(randomId.toString(), {
                    timestamp: Date.now(),
                    expireAt: Date.now() + EXPIRY_MS
                  });
                }
              }
              
              // Call original and capture response
              const promise = originalInvoke.call(this, method, params, options);
              
              return promise.then(result => {
                if (method === 'messages.sendMedia' || method === 'messages.sendMessage') {
                  extractMessageId(result, params);
                }
                return result;
              });
            };
            
            console.log("✅ Hooked apiManager.invokeApi");
          }
          
          // Store delete method
          window.__deleteMessage = function(msgId, peerId) {
            console.log("🗑️ Attempting to delete message:", msgId);
            
            const attempts = [];
            
            // Try apiManager
            if (apis.apiManager?.invokeApi) {
              attempts.push(
                apis.apiManager.invokeApi('messages.deleteMessages', {
                  id: [msgId],
                  revoke: true
                }).then(() => {
                  console.log("✅ Deleted via apiManager");
                  return true;
                })
              );
            }
            
            // Try appMessagesManager
            if (apis.appMessagesManager?.deleteMessages) {
              attempts.push(
                apis.appMessagesManager.deleteMessages(peerId, [msgId], true)
                  .then(() => {
                    console.log("✅ Deleted via appMessagesManager");
                    return true;
                  })
              );
            }
            
            if (attempts.length === 0) {
              console.error("❌ No delete methods available");
              return Promise.reject("No delete methods");
            }
            
            return Promise.any(attempts).catch(err => {
              console.error("❌ All delete attempts failed:", err);
            });
          };
        }
        
        function extractMessageId(result, params) {
          let msgId = null;
          let peerId = null;
          const randomId = (params?.random_id || params?.message?.random_id)?.toString();
          
          // Parse various response formats
          if (result?.updates) {
            result.updates.forEach(update => {
              if (update?._ === 'updateMessageID') {
                msgId = update.id;
              } else if (update?._ === 'updateNewMessage' || update?._ === 'updateNewChannelMessage') {
                msgId = update.message?.id;
                peerId = update.message?.peer_id;
              }
            });
          } else if (result?.id) {
            msgId = result.id;
          }
          
          if (msgId && randomId && pendingPhotos.has(randomId)) {
            const photoData = pendingPhotos.get(randomId);
            console.log(\`✅ Message sent! ID: \${msgId}, will delete in \${EXPIRY_MS}ms\`);
            
            const deleteIn = photoData.expireAt - Date.now();
            
            setTimeout(() => {
              if (window.__deleteMessage) {
                window.__deleteMessage(msgId, peerId);
              }
            }, Math.max(0, deleteIn));
            
            pendingPhotos.delete(randomId);
          }
        }
        
        function setupDOMFallback() {
          console.log("⚠️ Using DOM fallback method (less reliable)");
          
          // Watch for new messages with photos
          const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
              mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1 && node.classList?.contains('message')) {
                  const hasPhoto = node.querySelector('[class*="photo"], [class*="Photo"], .media-photo, img[class*="media"]');
                  const msgId = node.getAttribute('data-message-id') || node.getAttribute('data-mid');
                  
                  if (hasPhoto && msgId) {
                    console.log("📸 Photo message detected (DOM):", msgId);
                    
                    setTimeout(() => {
                      console.log("🗑️ Attempting to delete (DOM method):", msgId);
                      node.querySelector('[class*="delete"], [data-action="delete"]')?.click();
                      
                      // Try to click confirm
                      setTimeout(() => {
                        document.querySelector('[class*="confirm"], button[class*="danger"]')?.click();
                      }, 300);
                    }, EXPIRY_MS);
                  }
                }
              });
            });
          });
          
          observer.observe(document.body, {
            childList: true,
            subtree: true
          });
          
          console.log("✅ DOM observer active");
        }
        
        console.log("⏳ Waiting for Telegram to load...");
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(injectScript, 1000); // Wait 1s for Telegram to initialize
    });
  } else {
    setTimeout(injectScript, 1000);
  }
  
  console.log(\`⏱️ Extension loaded - Photos will expire in \${EXPIRY_TIME_SECONDS} seconds\`);
})();