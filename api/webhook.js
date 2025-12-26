import { createClient } from '@supabase/supabase-js';

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify Typeform signature (if configured)
    if (process.env.TYPEFORM_WEBHOOK_SECRET) {
      const signature = req.headers['typeform-signature'];
      if (!signature || !verifyTypeformSignature(req.body, signature)) {
        console.error('Invalid Typeform signature');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const payload = req.body;

    // Check payload size (Vercel limit is 4.5MB on Hobby tier)
    const payloadSize = JSON.stringify(payload).length;
    if (payloadSize > 4 * 1024 * 1024) {
      console.error(`Payload too large: ${payloadSize} bytes`);
      return res.status(413).json({ error: 'Payload too large' });
    }

    // Validate payload structure
    if (!payload || !payload.form_response) {
      console.error('Invalid payload structure:', payload);
      return res.status(400).json({ error: 'Invalid payload structure' });
    }

    // Extract form data
    const formResponse = payload.form_response;
    if (!formResponse.token || !formResponse.form_id) {
      console.error('Missing required fields:', formResponse);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const submissionId = formResponse.token;
    const formId = formResponse.form_id;
    const submittedAt = formResponse.submitted_at || new Date().toISOString();

    console.log(`Processing submission: ${submissionId}`);

    // STEP 1: Save to Supabase (critical - must succeed)
    let dbSubmissionId;
    try {
      dbSubmissionId = await saveToSupabase(formResponse);
    } catch (supabaseError) {
      console.error('Supabase save failed:', supabaseError);
      // Return 500 so Typeform retries
      return res.status(500).json({
        error: 'Database save failed',
        message: supabaseError.message
      });
    }

    // STEP 2: Update Airtable (best effort)
    try {
      await updateAirtable(formResponse, dbSubmissionId);
    } catch (airtableError) {
      console.error('Airtable update failed:', airtableError);
      // Don't fail the webhook - Airtable is nice-to-have
    }

    return res.status(200).json({
      success: true,
      submission_id: submissionId
    });

  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// Save to Supabase
async function saveToSupabase(formResponse) {
  // Check if submission already exists (idempotency)
  const { data: existing } = await supabase
    .from('submissions')
    .select('id')
    .eq('submission_id', formResponse.token)
    .single();

  if (existing) {
    console.log(`Submission ${formResponse.token} already exists, skipping`);
    return existing.id;
  }

  // Insert submission (raw_data contains complete backup)
  const { data: submission, error: submissionError } = await supabase
    .from('submissions')
    .insert({
      form_id: formResponse.form_id,
      submission_id: formResponse.token,
      submitted_at: formResponse.submitted_at,
      raw_data: formResponse, // Complete JSON backup stored here
    })
    .select()
    .single();

  if (submissionError) throw submissionError;

  // Insert answers (if any exist)
  if (formResponse.answers && formResponse.answers.length > 0) {
    const answers = formResponse.answers
      .filter(answer => answer && answer.field) // Skip invalid answers
      .map(answer => ({
        submission_id: submission.id,
        question_id: answer.field.id,
        question_text: answer.field.ref || answer.field.title || 'Unknown',
        answer_text: getAnswerText(answer),
        answer_type: answer.type,
      }));

    if (answers.length > 0) {
      const { error: answersError } = await supabase
        .from('answers')
        .insert(answers);

      if (answersError) {
        console.error('Error saving answers:', answersError);
        // Don't fail the whole submission for answer errors
      }
    }
  }

  console.log(`Saved to Supabase: ${submission.id}`);
  return submission.id;
}

// Update Airtable with improved mapping and logging
async function updateAirtable(formResponse, dbSubmissionId) {
  // Check if record already exists in Airtable
  const searchUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}?filterByFormula={Submission ID}="${formResponse.token}"`;
  
  const searchResponse = await fetch(searchUrl, {
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
    },
  });

  const searchData = await searchResponse.json();
  
  if (searchData.records && searchData.records.length > 0) {
    console.log('Record already exists in Airtable, skipping');
    return;
  }

  const answers = formResponse.answers || [];

  // === DEBUG LOGGING ===
  console.log('=== TYPEFORM PAYLOAD DEBUG ===');
  console.log(`Total answers received: ${answers.length}`);
  answers.forEach((answer, idx) => {
    console.log(`Answer ${idx}:`, {
      type: answer.type,
      fieldId: answer.field?.id,
      fieldTitle: answer.field?.title,
      fieldRef: answer.field?.ref,
      hasValue: !!getAnswerText(answer),
      answerPreview: getAnswerText(answer)?.substring(0, 50)
    });
  });

  // Build base fields
  const fields = {
    'Submission ID': formResponse.token,
    'Submitted At': formResponse.submitted_at,
    'Form Name': formResponse.definition?.title || 'Unknown',
    'Status': 'New',
  };

  if (process.env.SUPABASE_URL) {
    fields['View Data'] = `${process.env.SUPABASE_URL}/project/default/editor`;
  }

  // Track unmapped fields for logging
  const unmappedFields = [];
  let mappedCount = 0;

  // Map ALL answers to Airtable columns with improved logic
  answers.forEach((answer) => {
    // Try both title and ref for matching
    const questionTitle = (answer.field?.title || '').toLowerCase().trim();
    const questionRef = (answer.field?.ref || '').toLowerCase().trim();
    const answerValue = getAnswerText(answer);

    // Skip if no answer value
    if (!answerValue || answerValue === 'N/A' || answerValue === '') {
      console.log(`⚠️  Skipping empty answer for: ${answer.field?.title || answer.field?.ref}`);
      return;
    }

    // Truncate to Airtable's 100k character limit
    const truncatedValue = answerValue.length > 100000 
      ? answerValue.substring(0, 100000) 
      : answerValue;

    // Use a helper function to check if question matches any keywords
    const matchesAny = (...keywords) => {
      return keywords.some(keyword => 
        questionTitle.includes(keyword.toLowerCase()) || 
        questionRef.includes(keyword.toLowerCase())
      );
    };

    let mapped = false;

    // === CONTACT INFORMATION ===
    if (matchesAny('full name', 'your name', 'name')) {
      fields['Full Name'] = truncatedValue;
      fields['Name'] = truncatedValue; // Legacy field
      mapped = true;
    } 
    else if (matchesAny('email', 'e-mail', 'email address')) {
      fields['Email Address'] = truncatedValue;
      fields['Email'] = truncatedValue; // Legacy field
      mapped = true;
    } 
    else if (matchesAny('mobile', 'phone', 'whatsapp', 'contact number')) {
      fields['Mobile Number'] = truncatedValue;
      mapped = true;
    }

    // === DEMOGRAPHIC INFO ===
    else if (matchesAny('age group', 'age range', 'how old')) {
      fields['Age Group'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('where do you currently live', 'current location', 'living in')) {
      fields['Current Location'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('current profession', 'occupation', 'what do you do')) {
      fields['Current Profession'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('household income', 'annual income', 'family income')) {
      fields['Household Income'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('household size', 'family size', 'how many people')) {
      fields['Household Size'] = truncatedValue;
      mapped = true;
    }

    // === PURCHASE/INVESTMENT INFO ===
    else if (matchesAny('exploring this purchase', 'how long', 'timeline')) {
      fields['Purchase Duration'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('buying journey', 'purchase stage', 'where are you')) {
      fields['Buying Journey Stage'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('properties have you purchased', 'bought before', 'previous purchases')) {
      fields['Properties Purchased Before'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('prompting this property search', 'why now', 'what prompted')) {
      fields['Purchase Prompt'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('dream property', 'ideal investment', 'perfect property')) {
      fields['Dream Property Description'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('preferred location', 'where would you like', 'location preference')) {
      fields['Preferred Locations'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('main intention behind this investment', 'investment goal', 'why invest')) {
      fields['Investment Intention'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('inspires this investment', 'what inspires', 'motivation')) {
      fields['Investment Inspiration'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('tell us more') && matchesAny('investment')) {
      fields['Investment Details'] = truncatedValue;
      mapped = true;
    }

    // === PROPERTY SPECIFICATIONS ===
    else if (matchesAny('vibe are you looking', 'atmosphere', 'what vibe')) {
      fields['Preferred Vibe'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('asset type', 'property type', 'type of property')) {
      fields['Asset Type'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('budget range', 'price range', 'how much')) {
      fields['Budget Range'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('ownership structure', 'how own', 'ownership type')) {
      fields['Ownership Structure'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('possession timeline', 'when move in', 'possession date')) {
      fields['Possession Timeline'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('close the deal', 'purchase timeline', 'when buy')) {
      fields['Deal Closure Timeline'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('management model', 'property management', 'manage property')) {
      fields['Management Model'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('funding preference', 'payment', 'financing')) {
      fields['Funding Preference'] = truncatedValue;
      mapped = true;
    }

    // === LOCATION PREFERENCES ===
    else if (matchesAny('matters most') && matchesAny('location')) {
      fields['Location Priorities'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('climate do you', 'weather preference', 'climate preference')) {
      fields['Preferred Climate'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('type of area', 'urban', 'rural', 'area preference')) {
      fields['Area Type Preference'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('too far', 'distance', 'how far')) {
      fields['Distance Tolerance'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('tell us more') && matchesAny('location')) {
      fields['Location Details'] = truncatedValue;
      mapped = true;
    }

    // === COMMUNITY & ENVIRONMENT ===
    else if (matchesAny('community setup', 'type of community', 'community type')) {
      fields['Community Setup'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('community be friendly', 'friendly for', 'suitable for')) {
      fields['Community Friendly For'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('natural features', 'nature', 'natural surroundings')) {
      fields['Natural Features'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('terrain', 'topography', 'land type')) {
      fields['Terrain Preference'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('preferred views', 'view preference', 'what views')) {
      fields['Preferred Views'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('outdoor amenities', 'outdoor facilities', 'outdoor features')) {
      fields['Outdoor Amenities'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('tell us more') && matchesAny('amenities')) {
      fields['Amenities Details'] = truncatedValue;
      mapped = true;
    }

    // === HOME SPECIFICATIONS ===
    else if (matchesAny('unit configuration', 'bedrooms', 'bhk', 'rooms')) {
      fields['Unit Configuration'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('facing direction', 'vastu', 'which direction')) {
      fields['House Facing Direction'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('furnishing level', 'furnished', 'furnishing')) {
      fields['Furnishing Level'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('interior style', 'design style', 'aesthetic')) {
      fields['Interior Style'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('smart home', 'automation', 'smart features')) {
      fields['Smart Home Preferences'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('must-have features', 'essential features', 'must have')) {
      fields['Must Have Features'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('tell us more') && matchesAny('home')) {
      fields['Home Details'] = truncatedValue;
      mapped = true;
    }

    // === REFERRAL & ADDITIONAL ===
    else if (matchesAny('where did you hear', 'hear about us', 'how did you find', 'referral')) {
      fields['Referral Source'] = truncatedValue;
      mapped = true;
    }
    else if (matchesAny('tell us anything else', 'additional', 'anything else', 'comments')) {
      fields['Additional Notes'] = truncatedValue;
      mapped = true;
    }

    // Track unmapped fields
    if (mapped) {
      mappedCount++;
      console.log(`✅ Mapped: "${answer.field?.title || answer.field?.ref}"`);
    } else {
      unmappedFields.push({
        title: answer.field?.title,
        ref: answer.field?.ref,
        type: answer.type,
        valuePreview: answerValue.substring(0, 50)
      });
      console.log(`❌ UNMAPPED: "${answer.field?.title || answer.field?.ref}" (ref: ${answer.field?.ref})`);
    }
  });

  // === SUMMARY LOGGING ===
  console.log('\n=== AIRTABLE MAPPING SUMMARY ===');
  console.log(`Total answers: ${answers.length}`);
  console.log(`Successfully mapped: ${mappedCount}`);
  console.log(`Unmapped fields: ${unmappedFields.length}`);
  
  if (unmappedFields.length > 0) {
    console.log('\n⚠️  UNMAPPED FIELDS DETAILS:');
    unmappedFields.forEach((field, idx) => {
      console.log(`${idx + 1}. Title: "${field.title}" | Ref: "${field.ref}" | Type: ${field.type}`);
      console.log(`   Value preview: "${field.valuePreview}..."`);
    });
  }

  console.log('\n📋 Fields being sent to Airtable:');
  console.log(Object.keys(fields));

  // Send to Airtable
  const record = { fields };

  const response = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(record),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Airtable API Error:', errorText);
    throw new Error(`Airtable error: ${response.statusText} - ${errorText}`);
  }

  const responseData = await response.json();
  console.log('✅ Successfully created Airtable record:', responseData.id);
}

// Verify Typeform webhook signature
function verifyTypeformSignature(payload, signature) {
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha256', process.env.TYPEFORM_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('base64');
  return `sha256=${hash}` === signature;
}

// Helper to extract answer text
function getAnswerText(answer) {
  if (!answer) return null;

  switch (answer.type) {
    case 'text':
    case 'email':
    case 'url':
      return answer[answer.type];
    case 'choice':
      return answer.choice?.label;
    case 'choices':
      return answer.choices?.labels?.join(', ');
    case 'number':
      return answer.number?.toString();
    case 'boolean':
      return answer.boolean ? 'Yes' : 'No';
    case 'date':
      return answer.date;
    case 'file_url':
      return answer.file_url;
    default:
      return JSON.stringify(answer);
  }
}
