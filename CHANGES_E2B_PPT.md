# PowerPoint Generation Migration to E2B

## Summary

The PowerPoint generation feature has been completely rewritten to use **E2B Code Interpreter** sandbox execution with the `pptxgenjs` library, replacing the previous client-side JSON-based approach.

## What Changed

### 1. **New Files Created**

- **`src/services/e2bService.ts`**: Service to communicate with E2B backend server
- **`e2b-server-example.js`**: Reference implementation of E2B backend server with pptxgenjs auto-install
- **`E2B_PPT_SETUP.md`**: Complete setup and troubleshooting guide

### 2. **Modified Files**

#### `src/services/geminiService.ts`
- **Before**: `generatePPTContent()` returned JSON structure `{ title, slides: [{title, content}] }`
- **After**: Returns executable JavaScript code using pptxgenjs that outputs base64-encoded PPTX

#### `src/App.tsx`
- **Before**: Used client-side `PptxGenJS` library to build presentation from JSON
- **After**: 
  - Sends generated code to E2B sandbox via `executeCode()`
  - Receives base64-encoded PPTX file
  - Converts to Blob and triggers download
  - Removed `pptxgenjs` import (no longer needed client-side)

#### `.env.example`
- Added `VITE_E2B_API_URL=http://localhost:3001` configuration

### 3. **Removed Dependencies**

Client-side `pptxgenjs` is no longer bundled with the frontend (reduces bundle size by ~500KB).

## Architecture Flow

```
User clicks "Generate PPT"
    ↓
Frontend: generatePPTContent(transcription, slideCount)
    ↓
Gemini AI: Generates executable pptxgenjs code
    ↓
Frontend: executeCode(code, 'javascript')
    ↓
E2B Backend: Creates sandbox → Installs pptxgenjs → Executes code
    ↓
E2B Sandbox: Runs code → Outputs base64 PPTX
    ↓
Frontend: Converts base64 → Blob → Downloads file
```

## Benefits

1. **Security**: Code executes in isolated E2B sandbox, not in user's browser
2. **Reliability**: Server-side execution with proper error handling
3. **Smaller Bundle**: Removed 500KB+ pptxgenjs from client bundle
4. **Flexibility**: Can easily add more libraries (charts, images) to E2B sandbox
5. **Scalability**: E2B handles resource limits and timeouts automatically

## Setup Required

### Backend Server

You need to run a separate E2B backend server. See `e2b-server-example.js` for reference implementation.

**Quick Start:**
```bash
# Create server directory
mkdir e2b-server && cd e2b-server

# Copy example server
cp ../web/Lumina-AI-/e2b-server-example.js server.js

# Create package.json
npm init -y
npm install express cors @e2b/code-interpreter dotenv

# Create .env
echo "E2B_API_KEY=e2b_89c7aa75f1dfd77d8f5336a2e1e5a88163fc45ab" > .env

# Start server
node server.js
```

### Frontend Configuration

Add to your `.env`:
```
VITE_E2B_API_URL=http://localhost:3001
```

## Testing

1. Start E2B backend server (port 3001)
2. Start frontend dev server
3. Process an audio file to get a meeting transcription
4. Go to Assets tab
5. Click "Generate Presentation"
6. Wait for Gemini to generate code → E2B to execute → Download to trigger

## Backward Compatibility

Old PPT assets (created before this change) cannot be re-downloaded. The system shows an alert: "This presentation was generated using E2B sandbox. Please regenerate it to download again."

This is intentional since the old format stored JSON structure, not the actual PPTX file.

## Troubleshooting

See `E2B_PPT_SETUP.md` for detailed troubleshooting steps.

**Common Issues:**
- **"E2B execution failed"**: E2B backend not running or wrong URL in `.env`
- **"pptxgenjs is not defined"**: Server didn't auto-install pptxgenjs (check server logs)
- **Empty output**: Code execution error (check E2B backend logs)

## Future Enhancements

- Cache generated PPTX in Supabase storage for re-download
- Add custom themes and templates
- Support for charts, images, and tables in slides
- Preview before download
- Batch generation for multiple meetings
