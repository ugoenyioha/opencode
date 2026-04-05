const fs = require('fs');

const filePath = '/Users/uenyioha/tmp/opencode-anthropic-auth-gitea/index.mjs';
let content = fs.readFileSync(filePath, 'utf8');

const oldInstructions = 'instructions: `Accounts:\\n${lines.join("\\n")}\\n\\nEnter number to remove, or press Enter to cancel:`,';
const newInstructions = 'instructions: `Accounts:\\n${lines.join("\\n")}\\n\\nEnter a number to select as active (e.g., "1" or "sel 1"), or prefix with "rm " to remove (e.g., "rm 1"). Press Enter to cancel:`,';

const oldCallback = `              callback: async (answer) => {
                if (answer) {
                  const index = Number.parseInt(answer, 10) - 1;
                  if (
                    !Number.isNaN(index) &&
                    index >= 0 &&
                    index < data.accounts.length
                  ) {
                    removeAccount(index);
                  }
                }
                return getExistingOAuthResult();
              },`;

const newCallback = `              callback: async (answer) => {
                if (answer) {
                  const trimmed = answer.trim();
                  const isRm = trimmed.startsWith("rm ");
                  const isSel = trimmed.startsWith("sel ");
                  
                  let numStr = trimmed;
                  if (isRm) numStr = trimmed.substring(3).trim();
                  else if (isSel) numStr = trimmed.substring(4).trim();
                  
                  const index = Number.parseInt(numStr, 10) - 1;
                  
                  if (
                    !Number.isNaN(index) &&
                    index >= 0 &&
                    index < data.accounts.length
                  ) {
                    if (isRm) {
                      removeAccount(index);
                    } else {
                      const currentData = loadAccounts();
                      currentData.activeIndex = index;
                      saveAccounts(currentData);
                      
                      const active = currentData.accounts[index];
                      if (active) {
                        try {
                          await authClient.auth.set({
                            path: { id: "anthropic" },
                            body: {
                              type: "oauth",
                              refresh: active.refresh,
                              access: active.access,
                              expires: active.expires,
                            },
                          });
                        } catch (e) {
                          console.warn("Failed to sync active account to authClient", e);
                        }
                      }
                    }
                  }
                }
                return getExistingOAuthResult();
              },`;

if (content.includes(oldInstructions) && content.includes(oldCallback)) {
  content = content.replace(oldInstructions, newInstructions);
  content = content.replace(oldCallback, newCallback);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Successfully patched index.mjs');
} else {
  console.error('Could not find the target strings to replace in index.mjs');
  if (!content.includes(oldInstructions)) console.error('oldInstructions not found');
  if (!content.includes(oldCallback)) console.error('oldCallback not found');
}
