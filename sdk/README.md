# Clara Flow SDK v2.0 🚀

**Modern JavaScript SDK for executing Clara AI agent workflows with zero configuration**

[![npm version](https://badge.fury.io/js/clara-flow-sdk.svg)](https://www.npmjs.com/package/clara-flow-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ Features

- 🎯 **Zero Configuration** - Works out of the box
- 🧠 **AI-Ready** - Built-in LLM and AI node support
- 🔗 **Universal** - Node.js, Browser, and CDN compatible
- ⚡ **Fast** - Lightweight and optimized execution engine
- 🛡️ **Type Safe** - Full TypeScript support
- 🎨 **Custom Nodes** - Create your own node types
- 📦 **Clara Studio Compatible** - Import workflows directly

## 🚀 Quick Start

### Installation

```bash
npm install clara-flow-sdk
```

### Basic Usage (5 lines of code!)

```javascript
import { ClaraFlowRunner } from 'clara-flow-sdk';

const runner = new ClaraFlowRunner();
const result = await runner.execute(workflow, { input: 'Hello World!' });
console.log(result);
```

## 📖 Complete Examples

### 1. Simple Text Processing

```javascript
import { ClaraFlowRunner } from 'clara-flow-sdk';

// Create a simple workflow
const textWorkflow = {
  nodes: [
    {
      id: 'input-1',
      type: 'input',
      name: 'User Input',
      data: { value: 'Hello' },
      outputs: [{ id: 'output', name: 'Output' }]
    },
    {
      id: 'process-1',
      type: 'static-text',
      name: 'Add Greeting',
      data: { text: 'Welcome: ' },
      inputs: [{ id: 'input', name: 'Input' }],
      outputs: [{ id: 'output', name: 'Output' }]
    },
    {
      id: 'combine-1',
      type: 'combine-text',
      name: 'Combine',
      data: { separator: '' },
      inputs: [
        { id: 'text1', name: 'Text1' },
        { id: 'text2', name: 'Text2' }
      ],
      outputs: [{ id: 'output', name: 'Output' }]
    },
    {
      id: 'output-1',
      type: 'output',
      name: 'Final Result',
      inputs: [{ id: 'input', name: 'Input' }]
    }
  ],
  connections: [
    { sourceNodeId: 'process-1', sourcePortId: 'output', targetNodeId: 'combine-1', targetPortId: 'text1' },
    { sourceNodeId: 'input-1', sourcePortId: 'output', targetNodeId: 'combine-1', targetPortId: 'text2' },
    { sourceNodeId: 'combine-1', sourcePortId: 'output', targetNodeId: 'output-1', targetPortId: 'input' }
  ]
};

// Execute workflow
const runner = new ClaraFlowRunner();
const result = await runner.execute(textWorkflow, { 'input-1': 'Clara!' });
console.log(result); // { "output-1": { "output": "Welcome: Clara!" } }
```

### 2. JSON Data Processing

```javascript
const jsonWorkflow = {
  nodes: [
    {
      id: 'data-input',
      type: 'input',
      name: 'JSON Data',
      data: { value: '{"user": {"name": "Alice", "profile": {"age": 30, "city": "NYC"}}}' },
      outputs: [{ id: 'output', name: 'Output' }]
    },
    {
      id: 'parse-name',
      type: 'json-parse',
      name: 'Extract Name',
      data: { field: 'user.name' },
      inputs: [{ id: 'input', name: 'JSON' }],
      outputs: [{ id: 'output', name: 'Output' }]
    },
    {
      id: 'parse-city',
      type: 'json-parse',
      name: 'Extract City',
      data: { field: 'user.profile.city' },
      inputs: [{ id: 'input', name: 'JSON' }],
      outputs: [{ id: 'output', name: 'Output' }]
    },
    {
      id: 'result',
      type: 'output',
      name: 'User Info',
      inputs: [{ id: 'input', name: 'Input' }]
    }
  ],
  connections: [
    { sourceNodeId: 'data-input', sourcePortId: 'output', targetNodeId: 'parse-name', targetPortId: 'input' },
    { sourceNodeId: 'parse-name', sourcePortId: 'output', targetNodeId: 'result', targetPortId: 'input' }
  ]
};

const result = await runner.execute(jsonWorkflow);
console.log(result); // Extracted: "Alice"
```

### 3. Custom Node Creation

```javascript
const runner = new ClaraFlowRunner();

// Register a custom node
runner.registerCustomNode({
  type: 'email-validator',
  name: 'Email Validator',
  executionCode: `
    function execute(inputs, properties, context) {
      const email = inputs.email || '';
      const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
      const isValid = emailRegex.test(email);
      
      context.log('Validating email: ' + email);
      
      return {
        output: isValid,
        email: email,
        status: isValid ? 'valid' : 'invalid'
      };
    }
  `
});

// Use custom node in workflow
const emailWorkflow = {
  nodes: [
    {
      id: 'email-input',
      type: 'input',
      name: 'Email',
      data: { value: 'user@example.com' },
      outputs: [{ id: 'output', name: 'Output' }]
    },
    {
      id: 'validator',
      type: 'email-validator',
      name: 'Validate Email',
      inputs: [{ id: 'email', name: 'Email' }],
      outputs: [{ id: 'output', name: 'Valid' }]
    },
    {
      id: 'result',
      type: 'output',
      name: 'Validation Result',
      inputs: [{ id: 'input', name: 'Input' }]
    }
  ],
  connections: [
    { sourceNodeId: 'email-input', sourcePortId: 'output', targetNodeId: 'validator', targetPortId: 'email' },
    { sourceNodeId: 'validator', sourcePortId: 'output', targetNodeId: 'result', targetPortId: 'input' }
  ]
};

const result = await runner.execute(emailWorkflow);
console.log(result); // Email validation result
```

### 4. AI/LLM Integration

```javascript
const aiWorkflow = {
  nodes: [
    {
      id: 'prompt',
      type: 'input',
      name: 'User Prompt',
      data: { value: 'Explain quantum computing in simple terms' },
      outputs: [{ id: 'output', name: 'Output' }]
    },
    {
      id: 'ai-chat',
      type: 'llm',
      name: 'AI Assistant',
      data: {
        apiKey: process.env.OPENAI_API_KEY,
        model: 'gpt-3.5-turbo',
        temperature: 0.7
      },
      inputs: [
        { id: 'user', name: 'User Message' },
        { id: 'system', name: 'System Message' }
      ],
      outputs: [{ id: 'output', name: 'Response' }]
    },
    {
      id: 'response',
      type: 'output',
      name: 'AI Response',
      inputs: [{ id: 'input', name: 'Input' }]
    }
  ],
  connections: [
    { sourceNodeId: 'prompt', sourcePortId: 'output', targetNodeId: 'ai-chat', targetPortId: 'user' },
    { sourceNodeId: 'ai-chat', sourcePortId: 'output', targetNodeId: 'response', targetPortId: 'input' }
  ]
};

const result = await runner.execute(aiWorkflow);
console.log(result['response'].output); // AI explanation
```

## 🌐 Browser Usage

### CDN (Quick Start)

```html
<!DOCTYPE html>
<html>
<head>
    <title>Clara Flow SDK Demo</title>
</head>
<body>
    <script src="https://unpkg.com/clara-flow-sdk@2.0.0/dist/clara-flow-sdk.umd.min.js"></script>
    <script>
        const runner = new ClaraFlowSDK.ClaraFlowRunner();
        
        const simpleFlow = {
            nodes: [
                { id: 'in', type: 'input', data: { value: 'Hello Browser!' }, outputs: [{ id: 'output' }] },
                { id: 'out', type: 'output', inputs: [{ id: 'input' }] }
            ],
            connections: [
                { sourceNodeId: 'in', sourcePortId: 'output', targetNodeId: 'out', targetPortId: 'input' }
            ]
        };
        
        runner.execute(simpleFlow).then(result => {
            console.log('Result:', result);
        });
    </script>
</body>
</html>
```

### Browser with File Upload

```html
<input type="file" id="workflow-file" accept=".json">
<button onclick="runWorkflow()">Run Workflow</button>

<script>
async function runWorkflow() {
    const fileInput = document.getElementById('workflow-file');
    const file = fileInput.files[0];
    
    if (file) {
        const workflow = await ClaraFlowSDK.BrowserUtils.loadFlowFromFile(file);
        const runner = new ClaraFlowSDK.ClaraFlowRunner();
        const result = await runner.execute(workflow);
        console.log('Workflow result:', result);
    }
}
</script>
```

## 📋 Built-in Node Types

| Node Type | Description | Example Use Case |
|-----------|-------------|------------------|
| `input` | Accept user input | Form data, parameters |
| `output` | Display results | Final output, responses |
| `static-text` | Fixed text content | Templates, prompts |
| `combine-text` | Merge text inputs | String concatenation |
| `json-parse` | Parse JSON data | API response processing |
| `if-else` | Conditional logic | Decision making |
| `llm` | AI language model | Chat, text generation |
| `structured-llm` | Structured AI output | JSON generation |
| `api-request` | HTTP requests | External API calls |

## ⚙️ Configuration Options

```javascript
const runner = new ClaraFlowRunner({
  enableLogging: true,        // Enable console logging
  timeout: 30000,            // Execution timeout (ms)
  logLevel: 'info',          // Log level: 'info', 'warn', 'error'
  maxRetries: 3              // Max retry attempts
});
```

## 🔧 Clara Studio Integration

Import workflows directly from Clara Studio:

```javascript
// Export from Clara Studio as "SDK Enhanced" format
const studioExport = {
  format: 'clara-sdk',
  version: '1.0.0',
  flow: { /* workflow definition */ },
  customNodes: [ /* custom node definitions */ ]
};

// Execute directly
const result = await runner.execute(studioExport, inputs);
```

## 🐛 Error Handling

```javascript
try {
  const result = await runner.execute(workflow, inputs);
  console.log('Success:', result);
} catch (error) {
  console.error('Workflow failed:', error.message);
  
  // Get detailed logs
  const logs = runner.getLogs();
  console.log('Execution logs:', logs);
}
```

## 📊 Monitoring & Debugging

```javascript
const runner = new ClaraFlowRunner({ enableLogging: true });

// Execute workflow
await runner.execute(workflow);

// Get execution logs
const logs = runner.getLogs();
logs.forEach(log => {
  console.log(`[${log.level}] ${log.message}`, log.data);
});

// Clear logs
runner.clearLogs();
```

## 🚀 Server Deployment (Coming Soon)

The SDK is designed to work seamlessly with server deployment:

```javascript
// Future server integration
import express from 'express';
import { ClaraFlowRunner } from 'clara-flow-sdk';

const app = express();
const runner = new ClaraFlowRunner();

app.post('/execute', async (req, res) => {
  try {
    const { workflow, inputs } = req.body;
    const result = await runner.execute(workflow, inputs);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

## 📝 TypeScript Support

```typescript
import { ClaraFlowRunner, BrowserUtils } from 'clara-flow-sdk';

interface WorkflowResult {
  [key: string]: any;
}

const runner: ClaraFlowRunner = new ClaraFlowRunner({
  enableLogging: true,
  timeout: 30000
});

const result: WorkflowResult = await runner.execute(workflow, inputs);
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- 📖 [Documentation](https://github.com/clara-ai/clara-flow-sdk/wiki)
- 🐛 [Issue Tracker](https://github.com/clara-ai/clara-flow-sdk/issues)
- 💬 [Discord Community](https://discord.gg/clara)

---

**Made with ❤️ by the Clara Team** 