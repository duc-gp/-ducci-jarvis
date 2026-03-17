import { createClient } from './provider.js';

const DEFAULT_PROMPT = 'Please describe this image in detail. Include all visible text, objects, colors, layout, and any other relevant details.';

/**
 * Sends a one-shot image analysis request to the configured vision model.
 * No chat history is included — only the image and an optional caption-based prompt.
 *
 * @param {object} attachment - { url: 'data:image/jpeg;base64,...' }
 * @param {string} caption - optional user-provided caption / question
 * @param {object} config - full app config (must include visionProvider, visionModel, visionApiKey)
 * @returns {Promise<string>} - the vision model's description
 */
export async function describeImage(attachment, caption, config) {
  const visionConfig = {
    provider: config.visionProvider,
    apiKey: config.visionApiKey,
  };

  const client = createClient(visionConfig);

  const textPrompt = caption?.trim()
    ? `The user sent this image with the following message: "${caption.trim()}"\n\nPlease describe what you see in the image in detail, paying special attention to anything relevant to their message.`
    : DEFAULT_PROMPT;

  const response = await client.chat.completions.create({
    model: config.visionModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: attachment.url } },
          { type: 'text', text: textPrompt },
        ],
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || '(no description returned)';
}
