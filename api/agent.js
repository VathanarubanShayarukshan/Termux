// உங்களது போன் நம்பரை இங்கே மாற்றவும் (பாதுகாப்பிற்கு)
// இந்த நம்பரில் இருந்து வரும் SMS-கள் மட்டுமே இயங்கும்
const ALLOWED_NUMBER = "+94767751412"; 

export default async function handler(req, res) {
    // Termux ரன்னர் அனுப்பும் POST ரெக்வெஸ்ட்டை மட்டும் ஏற்கும்
        if (req.method === 'POST') {
                const { sender, command } = req.body;

                        console.log(`Received SMS from ${sender}: ${command}`);

                                // அனுப்பியவர் நீங்களா என்று சரிபார்க்கிறது
                                        if (sender === ALLOWED_NUMBER) {
                                                    // கட்டளை சரியானது, இயக்கலாம் என்று Termux-க்கு பதில் அனுப்பும்
                                                                return res.status(200).json({ 
                                                                                action: "execute", 
                                                                                                message: "Authorized command." 
                                                                                                            });
                                                                                                                    } else {
                                                                                                                                // வேறு யாராவது அனுப்பினால் அதை நிராகரிக்கும்
                                                                                                                                            return res.status(200).json({ 
                                                                                                                                                            action: "deny", 
                                                                                                                                                                            message: "Unauthorized sender. Ignored." 
                                                                                                                                                                                        });
                                                                                                                                                                                                }
                                                                                                                                                                                                    }

                                                                                                                                                                                                        // மற்ற ரெக்வெஸ்ட்களைத் தடுக்கும்
                                                                                                                                                                                                            return res.status(405).json({ error: "Method not allowed" });
                                                                                                                                                                                                            }
