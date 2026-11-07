/* ==========================================================================================================
   Rishta Connect Global: translation layer (English, Urdu, Arabic)

   English is the source text written in index.html and in the server's messages. This file turns it into
   Urdu or Arabic after the page is drawn, with no change to the page's own code:

     1. DICT        English text -> [Urdu, Arabic]. The text must match exactly (extra spaces and line breaks
                    are ignored). Add new screens here; the English key is the text exactly as shown.
     2. PATTERNS    for sentences that contain a number, a name or an email (for example "Page 2 of 5").
     3. The walker  visits EVERY text node on the page, plus the words inside placeholders, tooltips, button
                    labels, image descriptions, the page title and the browser's alert/confirm/prompt boxes.
     4. The watcher re-translates anything the page adds or changes later (new screens, pop-ups, messages).

   Switching language is reversible: the original English is remembered, so choosing English again restores it
   without reloading. Text typed by people (names, "about me", chat messages, reviews) is never translated:
   it is marked data-notr, or sits inside .chat / .b / textarea / input.

   Developer tools (browser console):  I18N.missing()  lists English text that has no translation yet.
                                       I18N.translate('Log out', 'ur')  tests one phrase.
   Ask a native reader to check the wording before launch, then edit the entries below.
   ========================================================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 1. dictionary ---------------- */
  const DICT = {
    "Why families trust us": ["خاندان ہم پر کیوں بھروسہ کرتے ہیں","لماذا تثق بنا العائلات"],
    "A respectful place to meet, with your family's peace of mind built in.": ["ملاقات کے لیے ایک باوقار جگہ، جس میں آپ کے خاندان کا اطمینان شامل ہے۔","مكان محترم للتعارف، يمنح عائلتك راحة البال."],
    "Verified badges": ["تصدیقی نشان","شارات التوثيق"],
    "Our team checks identity, photo and background before a badge is shown.": ["نشان دکھانے سے پہلے ہماری ٹیم شناخت، تصویر اور پس منظر کی جانچ کرتی ہے۔","يتحقق فريقنا من الهوية والصورة والخلفية قبل ظهور الشارة."],
    "Private by design": ["بنیادی طور پر نجی","خصوصية بالتصميم"],
    "Your photo stays hidden unless you choose to show it. Your email is never shown to members.": ["آپ کی تصویر اس وقت تک چھپی رہتی ہے جب تک آپ خود نہ دکھائیں۔ آپ کا ای میل ممبران کو کبھی نہیں دکھایا جاتا۔","تبقى صورتك مخفية ما لم تختر إظهارها، ولا يظهر بريدك الإلكتروني للأعضاء أبدًا."],
    "Safe conversations": ["محفوظ گفتگو","محادثات آمنة"],
    "Private chat with block and report tools, and every report is reviewed by our team.": ["بلاک اور رپورٹ کے ٹولز کے ساتھ نجی چیٹ، اور ہر رپورٹ ہماری ٹیم دیکھتی ہے۔","دردشة خاصة مع أدوات الحظر والإبلاغ، ويراجع فريقنا كل بلاغ."],
    "Secure payment": ["محفوظ ادائیگی","دفع آمن"],
    "Pay by mada, Visa or Mastercard through Moyasar. We never see your card number.": ["مویاسر کے ذریعے مدا، ویزا یا ماسٹرکارڈ سے ادائیگی کریں۔ ہم آپ کا کارڈ نمبر کبھی نہیں دیکھتے۔","ادفع ببطاقة مدى أو فيزا أو ماستركارد عبر ميسر. لا نرى رقم بطاقتك أبدًا."],
    "Where good beginnings start": ["جہاں اچھے رشتوں کا آغاز ہوتا ہے","حيث تبدأ البدايات الجميلة"],
    "Ratings and reviews": ["ریٹنگ اور تبصرے","التقييمات والمراجعات"],
    "No reviews yet": ["ابھی کوئی تبصرہ نہیں","لا توجد مراجعات بعد"],
    "Write a review": ["تبصرہ لکھیں","اكتب مراجعة"],
    "Edit your review": ["اپنا تبصرہ ایڈٹ کریں","عدّل مراجعتك"],
    "Your review": ["آپ کا تبصرہ","مراجعتك"],
    "Submit review": ["تبصرہ جمع کرائیں","إرسال المراجعة"],
    "Update review": ["تبصرہ اپ ڈیٹ کریں","تحديث المراجعة"],
    "Show more reviews": ["مزید تبصرے دکھائیں","عرض المزيد من المراجعات"],
    "Report review": ["تبصرے کی رپورٹ کریں","الإبلاغ عن المراجعة"],
    "Sign in to write a review.": ["تبصرہ لکھنے کے لیے لاگ اِن کریں۔","سجّل الدخول لكتابة مراجعة."],
    "Be honest and respectful. Please do not include links, phone numbers or personal details.": ["سچ اور احترام کے ساتھ لکھیں۔ براہِ کرم لنک، فون نمبر یا ذاتی تفصیلات نہ لکھیں۔","كن صادقًا ومحترمًا. يرجى عدم إضافة روابط أو أرقام هواتف أو تفاصيل شخصية."],
    "Share your experience (optional)": ["اپنا تجربہ بتائیں (اختیاری)","شاركنا تجربتك (اختياري)"],
    "Your rating": ["آپ کی ریٹنگ","تقييمك"],
    "A moderator has hidden this review. It is not shown to others.": ["ایک منتظم نے یہ تبصرہ چھپا دیا ہے۔ یہ دوسروں کو نظر نہیں آتا۔","أخفى أحد المشرفين هذه المراجعة، ولا تظهر للآخرين."],
    "Message this broker first. Only members who have been in touch can rate their experience.": ["پہلے اس بروکر کو پیغام بھیجیں۔ صرف رابطے میں رہنے والے ممبران ہی اپنا تجربہ ریٹ کر سکتے ہیں۔","راسل هذا الوسيط أولًا. فقط الأعضاء الذين تواصلوا معه يمكنهم تقييم تجربتهم."],
    "Create your profile first, then you can review brokers you have been in touch with.": ["پہلے اپنا پروفائل بنائیں، پھر آپ ان بروکرز کا تبصرہ کر سکیں گے جن سے رابطہ رہا ہو۔","أنشئ ملفك أولًا، ثم يمكنك تقييم الوسطاء الذين تواصلت معهم."],
    "Broker accounts cannot review other brokers.": ["بروکر اکاؤنٹس دوسرے بروکرز کا تبصرہ نہیں کر سکتے۔","لا يمكن لحسابات الوسطاء تقييم وسطاء آخرين."],
    "You can't review yourself.": ["آپ اپنا تبصرہ خود نہیں کر سکتے۔","لا يمكنك تقييم نفسك."],
    "You cannot review this broker.": ["آپ اس بروکر کا تبصرہ نہیں کر سکتے۔","لا يمكنك تقييم هذا الوسيط."],
    "Choose a rating from 1 to 5 stars.": ["1 سے 5 ستاروں میں سے ریٹنگ چنیں۔","اختر تقييمًا من 1 إلى 5 نجوم."],
    "Please explain in a few words what went wrong (at least 10 characters).": ["براہِ کرم چند لفظوں میں بتائیں کہ کیا غلط ہوا (کم از کم 10 حروف)۔","يرجى شرح ما حدث بكلمات قليلة (10 أحرف على الأقل)."],
    "Please do not include links, email addresses or phone numbers in a review.": ["براہِ کرم تبصرے میں لنک، ای میل یا فون نمبر نہ لکھیں۔","يرجى عدم كتابة روابط أو عناوين بريد أو أرقام هواتف في المراجعة."],
    "Thank you for your review": ["آپ کے تبصرے کا شکریہ","شكرًا على مراجعتك"],
    "Review updated": ["تبصرہ اپ ڈیٹ ہو گیا","تم تحديث المراجعة"],
    "Review deleted": ["تبصرہ حذف ہو گیا","تم حذف المراجعة"],
    "Thank you. Our team will look at it.": ["شکریہ۔ ہماری ٹیم اسے دیکھے گی۔","شكرًا. سيراجعها فريقنا."],
    "Too many review changes. Try again later.": ["تبصروں میں بہت زیادہ تبدیلیاں۔ بعد میں کوشش کریں۔","تغييرات كثيرة جدًا على المراجعات. حاول لاحقًا."],
    "Edit": ["ایڈٹ","تعديل"],
    "Delete": ["حذف کریں","حذف"],
    "Home": ["ہوم","الرئيسية"],
    "Membership": ["رکنیت","العضوية"],
    "Search": ["تلاش","بحث"],
    "Brokers": ["بروکرز","الوسطاء"],
    "Messages": ["پیغامات","الرسائل"],
    "My profile": ["میرا پروفائل","ملفي"],
    "Alerts": ["اطلاعات","التنبيهات"],
    "Login": ["لاگ اِن","دخول"],
    "Log out": ["لاگ آؤٹ","خروج"],
    "Admin": ["ایڈمن","المشرف"],
    "Broker account": ["بروکر اکاؤنٹ","حساب الوسيط"],
    "Find your life partner": ["اپنا جیون ساتھی تلاش کریں","ابحث عن شريك حياتك"],
    "Get started": ["شروع کریں","ابدأ الآن"],
    "Trusted": ["قابلِ اعتماد","موثوق"],
    "Safe": ["محفوظ","آمن"],
    "Genuine": ["مستند","أصيل"],
    "Verified profiles": ["تصدیق شدہ پروفائلز","ملفات موثّقة"],
    "Secure payment by Moyasar": ["مویاسر کے ذریعے محفوظ ادائیگی","دفع آمن عبر ميسر"],
    "Private, moderated chat": ["نجی، نگرانی شدہ گفتگو","محادثة خاصة وتحت الإشراف"],
    "Block and report tools": ["بلاک اور رپورٹ کے اوزار","أدوات الحظر والإبلاغ"],
    "How it works": ["یہ کیسے کام کرتا ہے","كيف يعمل"],
    "1. Sign in": ["۱۔ سائن اِن کریں","١. تسجيل الدخول"],
    "2. Create your profile": ["۲۔ اپنا پروفائل بنائیں","٢. أنشئ ملفك"],
    "3. Activate": ["۳۔ فعال کریں","٣. التفعيل"],
    "4. Connect": ["۴۔ رابطہ کریں","٤. تواصل"],
    "Continue with your Google account.": ["اپنے گوگل اکاؤنٹ سے جاری رکھیں۔","تابع باستخدام حساب جوجل."],
    "Tell us about yourself and what you seek.": ["ہمیں اپنے بارے میں اور اپنی پسند کے بارے میں بتائیں۔","أخبرنا عن نفسك وعمّا تبحث عنه."],
    "Pay securely by card (mada, Visa or Mastercard). Your profile goes live as soon as the payment is confirmed.": ["کارڈ (مدی، ویزا یا ماسٹر کارڈ) سے محفوظ ادائیگی کریں۔ ادائیگی کی تصدیق ہوتے ہی آپ کا پروفائل فعال ہو جاتا ہے۔","ادفع بأمان بالبطاقة (مدى أو فيزا أو ماستركارد). يصبح ملفك فعّالاً فور تأكيد الدفع."],
    "Browse verified members or work with a broker.": ["تصدیق شدہ ممبران دیکھیں یا کسی بروکر کے ساتھ کام کریں۔","تصفّح الأعضاء الموثّقين أو اعمل مع وسيط."],
    "Verified profiles, trusted brokers and private chat for families across the globe.": ["تصدیق شدہ پروفائلز، قابلِ اعتماد بروکرز اور دنیا بھر کے خاندانوں کے لیے نجی گفتگو۔","ملفات موثّقة ووسطاء موثوقون ومحادثة خاصة للعائلات حول العالم."],
    "Trusted brokers": ["قابلِ اعتماد بروکرز","وسطاء موثوقون"],
    "See all": ["سب دیکھیں","عرض الكل"],
    "View profile": ["پروفائل دیکھیں","عرض الملف"],
    "Verified": ["تصدیق شدہ","موثّق"],
    "Unverified": ["غیر تصدیق شدہ","غير موثّق"],
    "Welcome": ["خوش آمدید","مرحباً"],
    "Sign in to create your profile.": ["پروفائل بنانے کے لیے سائن اِن کریں۔","سجّل الدخول لإنشاء ملفك."],
    "Continue with Apple": ["ایپل کے ساتھ جاری رکھیں","المتابعة باستخدام Apple"],
    "Apple sign-in is not configured": ["ایپل سائن اِن دستیاب نہیں","تسجيل الدخول عبر Apple غير متاح"],
    "By continuing you agree to:": ["جاری رکھنے سے آپ اتفاق کرتے ہیں:","بالمتابعة فإنك توافق على:"],
    "Terms": ["شرائط","الشروط"],
    "Privacy Policy": ["پرائیویسی پالیسی","سياسة الخصوصية"],
    "Privacy": ["پرائیویسی","الخصوصية"],
    "Safety tips": ["حفاظتی مشورے","نصائح السلامة"],
    "Contact": ["رابطہ","اتصل بنا"],
    "© Rishta Connect Global · Real connections last forever": ["© رشتہ کنیکٹ گلوبل · حقیقی رشتے ہمیشہ قائم رہتے ہیں","© ريشتا كونكت جلوبال · العلاقات الحقيقية تدوم للأبد"],
    "Anyone can create a profile for free. A membership activates it so you appear in search and can browse and message members. Pay once per period; nothing renews by itself.": ["پروفائل بنانا مفت ہے۔ رکنیت اسے فعال کرتی ہے تاکہ آپ تلاش میں نظر آئیں اور ممبران کو دیکھ اور پیغام بھیج سکیں۔ ہر مدت کے لیے ایک بار ادائیگی کریں؛ کچھ خود بخود تجدید نہیں ہوتا۔","يمكن لأي شخص إنشاء ملف مجاناً. تفعّل العضوية ملفك لتظهر في البحث وتتصفح الأعضاء وتراسلهم. تدفع مرة واحدة لكل فترة ولا يتجدد شيء تلقائياً."],
    "Loading plans…": ["منصوبے لوڈ ہو رہے ہیں…","جارٍ تحميل الباقات…"],
    "View all profiles": ["تمام پروفائلز دیکھیں","عرض جميع الملفات"],
    "Unlimited messages": ["لامحدود پیغامات","رسائل غير محدودة"],
    "Profile highlights": ["نمایاں پروفائل","إبراز الملف"],
    "View trusted profiles": ["قابلِ اعتماد پروفائلز دیکھیں","عرض الملفات الموثوقة"],
    "Send limited messages": ["محدود پیغامات بھیجیں","إرسال رسائل محدودة"],
    "Basic search": ["بنیادی تلاش","بحث أساسي"],
    "All Premium features": ["پریمیم کی تمام خصوصیات","جميع مزايا بريميوم"],
    "Priority broker support": ["بروکر کی ترجیحی معاونت","دعم الوسيط ذو الأولوية"],
    "Verified badge boost": ["تصدیقی نشان میں اضافہ","تعزيز شارة التوثيق"],
    "Basic Plan": ["بنیادی پلان","الباقة الأساسية"],
    "Premium Plan": ["پریمیم پلان","باقة بريميوم"],
    "Premium Plus": ["پریمیم پلس","بريميوم بلس"],
    "Activate your profile": ["اپنا پروفائل فعال کریں","فعّل ملفك"],
    "Complete payment to activate": ["فعال کرنے کے لیے ادائیگی مکمل کریں","أكمل الدفع للتفعيل"],
    "Your card details go straight to Moyasar and never reach our servers. Your profile activates automatically once the payment is confirmed.": ["آپ کے کارڈ کی تفصیلات براہِ راست مویاسر کو جاتی ہیں اور ہمارے سرور تک کبھی نہیں پہنچتیں۔ ادائیگی کی تصدیق پر آپ کا پروفائل خود بخود فعال ہو جاتا ہے۔","تذهب بيانات بطاقتك مباشرة إلى ميسر ولا تصل إلى خوادمنا أبداً. يتفعّل ملفك تلقائياً فور تأكيد الدفع."],
    "Payment confirmed": ["ادائیگی کی تصدیق ہو گئی","تم تأكيد الدفع"],
    "Payment not completed": ["ادائیگی مکمل نہیں ہوئی","لم يكتمل الدفع"],
    "Confirming your payment…": ["آپ کی ادائیگی کی تصدیق ہو رہی ہے…","جارٍ تأكيد دفعتك…"],
    "Your profile is now active.": ["آپ کا پروفائل اب فعال ہے۔","ملفك فعّال الآن."],
    "No money was taken. You can try again.": ["کوئی رقم نہیں کٹی۔ آپ دوبارہ کوشش کر سکتے ہیں۔","لم يُسحب أي مبلغ. يمكنك المحاولة مرة أخرى."],
    "This usually takes a few seconds. Keep this page open.": ["عموماً چند سیکنڈ لگتے ہیں۔ یہ صفحہ کھلا رکھیں۔","يستغرق ذلك عادةً بضع ثوانٍ. أبقِ هذه الصفحة مفتوحة."],
    "Browse members": ["ممبران دیکھیں","تصفّح الأعضاء"],
    "Try again": ["دوبارہ کوشش کریں","حاول مرة أخرى"],
    "Renew or extend": ["تجدید یا توسیع کریں","جدّد أو مدّد"],
    "Close": ["بند کریں","إغلاق"],
    "Create your profile": ["اپنا پروفائل بنائیں","أنشئ ملفك"],
    "Edit your profile": ["اپنا پروفائل ایڈٹ کریں","عدّل ملفك"],
    "Full name": ["پورا نام","الاسم الكامل"],
    "Gender": ["جنس","الجنس"],
    "Female": ["خاتون","أنثى"],
    "Male": ["مرد","ذكر"],
    "Age": ["عمر","العمر"],
    "City, country": ["شہر، ملک","المدينة، الدولة"],
    "Marital status": ["ازدواجی حیثیت","الحالة الاجتماعية"],
    "Never married": ["غیر شادی شدہ","لم يسبق له الزواج"],
    "Divorced": ["طلاق یافتہ","مطلّق"],
    "Widowed": ["بیوہ/رنڈوا","أرمل"],
    "Education": ["تعلیم","التعليم"],
    "Occupation": ["پیشہ","المهنة"],
    "About you": ["آپ کے بارے میں","نبذة عنك"],
    "Looking for": ["تلاش ہے","أبحث عن"],
    "I am 18 or older and I agree to:": ["میری عمر 18 سال یا زیادہ ہے اور میں اتفاق کرتا/کرتی ہوں:","عمري 18 عاماً أو أكثر وأوافق على:"],
    "Terms & Conditions": ["شرائط و ضوابط","الشروط والأحكام"],
    "Save and continue to payment": ["محفوظ کریں اور ادائیگی پر جائیں","احفظ وتابع إلى الدفع"],
    "Save changes": ["تبدیلیاں محفوظ کریں","حفظ التغييرات"],
    "Cancel": ["منسوخ کریں","إلغاء"],
    "Edit profile": ["پروفائل ایڈٹ کریں","تعديل الملف"],
    "Active": ["فعال","فعّال"],
    "Pending payment": ["ادائیگی باقی","بانتظار الدفع"],
    "Settings and photo": ["ترتیبات اور تصویر","الإعدادات والصورة"],
    "Profile saved": ["پروفائل محفوظ ہو گیا","تم حفظ الملف"],
    "Search profiles": ["پروفائلز تلاش کریں","بحث عن الملفات"],
    "Any gender": ["کوئی بھی جنس","أي جنس"],
    "Any marital status": ["کوئی بھی ازدواجی حیثیت","أي حالة اجتماعية"],
    "City": ["شہر","المدينة"],
    "Min age": ["کم از کم عمر","الحد الأدنى للعمر"],
    "Max age": ["زیادہ سے زیادہ عمر","الحد الأقصى للعمر"],
    "Apply filters": ["فلٹر لگائیں","تطبيق التصفية"],
    "Clear": ["صاف کریں","مسح"],
    "Previous": ["پچھلا","السابق"],
    "Next": ["اگلا","التالي"],
    "View": ["دیکھیں","عرض"],
    "Report": ["رپورٹ کریں","إبلاغ"],
    "Send message": ["پیغام بھیجیں","إرسال رسالة"],
    "Save": ["محفوظ کریں","حفظ"],
    "No members match yet. Widen your filters or check back soon.": ["ابھی کوئی ممبر مطابقت نہیں رکھتا۔ فلٹر وسیع کریں یا بعد میں دیکھیں۔","لا يوجد أعضاء مطابقون بعد. وسّع التصفية أو عُد قريباً."],
    "My shortlist": ["میری منتخب فہرست","قائمتي المفضلة"],
    "Back to search": ["تلاش پر واپس","العودة للبحث"],
    "Back": ["واپس","رجوع"],
    "Nobody saved yet. Use \"Save\" on a profile to keep it here.": ["ابھی کوئی محفوظ نہیں۔ پروفائل پر \"محفوظ کریں\" دبا کر یہاں رکھیں۔","لم تحفظ أحداً بعد. استخدم \"حفظ\" في الملف ليظهر هنا."],
    "Marital status:": ["ازدواجی حیثیت:","الحالة الاجتماعية:"],
    "Education:": ["تعلیم:","التعليم:"],
    "Occupation:": ["پیشہ:","المهنة:"],
    "Safety tip: keep conversations on the site and never send money.": ["حفاظتی مشورہ: گفتگو اسی سائٹ پر رکھیں اور کبھی رقم نہ بھیجیں۔","نصيحة أمان: أبقِ المحادثات داخل الموقع ولا ترسل المال أبداً."],
    "Read more": ["مزید پڑھیں","اقرأ المزيد"],
    "Verified brokers": ["تصدیق شدہ بروکرز","وسطاء موثّقون"],
    "Become a broker": ["بروکر بنیں","كن وسيطاً"],
    "Matrimonial brokers approved by our team who manage introductions on your behalf.": ["ہماری ٹیم سے منظور شدہ رشتہ کروانے والے بروکرز جو آپ کی طرف سے تعارف کراتے ہیں۔","وسطاء زواج معتمدون من فريقنا يتولّون التعارف نيابةً عنك."],
    "No brokers have been approved yet.": ["ابھی کسی بروکر کی منظوری نہیں ہوئی۔","لم تتم الموافقة على أي وسيط بعد."],
    "Contact broker": ["بروکر سے رابطہ کریں","تواصل مع الوسيط"],
    "Matrimonial broker": ["رشتہ بروکر","وسيط زواج"],
    "Location:": ["مقام:","الموقع:"],
    "Experience:": ["تجربہ:","الخبرة:"],
    "Languages:": ["زبانیں:","اللغات:"],
    "Specialization:": ["مہارت:","التخصص:"],
    "No conversations yet. Message a member or contact a broker.": ["ابھی کوئی گفتگو نہیں۔ کسی ممبر کو پیغام بھیجیں یا بروکر سے رابطہ کریں۔","لا توجد محادثات بعد. راسل عضواً أو تواصل مع وسيط."],
    "Blocked members": ["بلاک کیے گئے ممبران","الأعضاء المحظورون"],
    "Unblock": ["بلاک ختم کریں","إلغاء الحظر"],
    "Block": ["بلاک کریں","حظر"],
    "Type a message…": ["پیغام لکھیں…","اكتب رسالة…"],
    "Send": ["بھیجیں","إرسال"],
    "Say Assalamu Alaikum to start.": ["السلام علیکم سے آغاز کریں۔","ابدأ بقول السلام عليكم."],
    "Never send money or bank details to someone you have not met in person with your family.": ["جس سے آپ اپنے خاندان کے ساتھ ذاتی طور پر نہیں ملے، اسے کبھی رقم یا بینک کی تفصیلات نہ بھیجیں۔","لا ترسل المال أو بيانات البنك لمن لم تلتقِ به شخصياً مع عائلتك."],
    "What happened?": ["کیا ہوا؟","ماذا حدث؟"],
    "Harassment or abuse": ["ہراسانی یا بدسلوکی","مضايقة أو إساءة"],
    "Scam or asking for money": ["فراڈ یا رقم کا مطالبہ","احتيال أو طلب مال"],
    "Fake or misleading profile": ["جعلی یا گمراہ کن پروفائل","ملف مزيّف أو مضلِّل"],
    "Inappropriate content": ["نامناسب مواد","محتوى غير لائق"],
    "Something else": ["کچھ اور","شيء آخر"],
    "Details (optional)": ["تفصیل (اختیاری)","التفاصيل (اختياري)"],
    "Also block this member": ["اس ممبر کو بلاک بھی کریں","احظر هذا العضو أيضاً"],
    "Send report": ["رپورٹ بھیجیں","إرسال البلاغ"],
    "Report sent. Thank you.": ["رپورٹ بھیج دی گئی۔ شکریہ۔","تم إرسال البلاغ. شكراً لك."],
    "Member blocked": ["ممبر بلاک ہو گیا","تم حظر العضو"],
    "Notifications": ["اطلاعات","الإشعارات"],
    "No notifications yet.": ["ابھی کوئی اطلاع نہیں۔","لا توجد إشعارات بعد."],
    "Warnings on your account": ["آپ کے اکاؤنٹ پر انتباہات","تحذيرات على حسابك"],
    "I understand": ["میں سمجھ گیا/گئی","فهمت"],
    "Appeal": ["اپیل","استئناف"],
    "Appeal this decision": ["اس فیصلے کی اپیل کریں","استأنف هذا القرار"],
    "Appeal this warning": ["اس انتباہ کی اپیل کریں","استأنف هذا التحذير"],
    "Appeal sent": ["اپیل بھیج دی گئی","تم إرسال الاستئناف"],
    "Send appeal": ["اپیل بھیجیں","إرسال الاستئناف"],
    "Your appeals": ["آپ کی اپیلیں","استئنافاتك"],
    "New": ["نیا","جديد"],
    "Why should this decision be reviewed?": ["اس فیصلے پر نظرِ ثانی کیوں ہونی چاہیے؟","لماذا ينبغي مراجعة هذا القرار؟"],
    "Under review": ["زیرِ جائزہ","قيد المراجعة"],
    "Settings": ["ترتیبات","الإعدادات"],
    "Account": ["اکاؤنٹ","الحساب"],
    "Profile photo": ["پروفائل کی تصویر","صورة الملف"],
    "Language": ["زبان","اللغة"],
    "Your data": ["آپ کا ڈیٹا","بياناتك"],
    "Hidden. Only you can see it.": ["پوشیدہ۔ صرف آپ اسے دیکھ سکتے ہیں۔","مخفية. أنت وحدك ترونها."],
    "Shown to active members.": ["فعال ممبران کو دکھائی جاتی ہے۔","تظهر للأعضاء النشطين."],
    "Show my photo to members": ["میری تصویر ممبران کو دکھائیں","أظهر صورتي للأعضاء"],
    "No photo yet. Your photo stays hidden until you choose to show it.": ["ابھی کوئی تصویر نہیں۔ جب تک آپ نہ چاہیں، آپ کی تصویر پوشیدہ رہتی ہے۔","لا توجد صورة بعد. تبقى صورتك مخفية حتى تختار إظهارها."],
    "Upload photo": ["تصویر اپ لوڈ کریں","رفع صورة"],
    "Replace photo": ["تصویر تبدیل کریں","استبدال الصورة"],
    "Remove photo": ["تصویر ہٹائیں","إزالة الصورة"],
    "Photo saved. It stays hidden until you choose to show it to members.": ["تصویر محفوظ ہو گئی۔ جب تک آپ ممبران کو دکھانا نہ چاہیں، یہ پوشیدہ رہے گی۔","تم حفظ الصورة. تبقى مخفية حتى تختار إظهارها للأعضاء."],
    "Use a clear photo of yourself. A new photo is checked by our team before it counts toward your Photo verification.": ["اپنی واضح تصویر استعمال کریں۔ نئی تصویر فوٹو تصدیق میں شمار ہونے سے پہلے ہماری ٹیم جانچتی ہے۔","استخدم صورة واضحة لك. يراجع فريقنا الصورة الجديدة قبل احتسابها في توثيق الصورة."],
    "Download a copy of everything we hold about you.": ["ہمارے پاس آپ کے بارے میں جو کچھ ہے اس کی کاپی ڈاؤن لوڈ کریں۔","نزّل نسخة من كل ما نحتفظ به عنك."],
    "Download my data": ["میرا ڈیٹا ڈاؤن لوڈ کریں","تنزيل بياناتي"],
    "Delete my account": ["میرا اکاؤنٹ حذف کریں","حذف حسابي"],
    "Type DELETE to confirm": ["تصدیق کے لیے DELETE لکھیں","اكتب DELETE للتأكيد"],
    "Your account has been deleted.": ["آپ کا اکاؤنٹ حذف کر دیا گیا ہے۔","تم حذف حسابك."],
    "This cannot be undone.": ["اسے واپس نہیں کیا جا سکتا۔","لا يمكن التراجع عن ذلك."],
    "Create your profile first.": ["پہلے اپنا پروفائل بنائیں۔","أنشئ ملفك أولاً."],
    "Founder Membership": ["فاؤنڈر ممبرشپ","عضوية المؤسسين"],
    "All Premium Plus features": ["پریمیم پلس کی تمام سہولیات","كل ميزات بريميوم بلس"],
    "Founder price for the whole period": ["پوری مدت کے لیے فاؤنڈر قیمت","سعر المؤسسين طوال المدة"],
    "Founder badge on your profile": ["آپ کے پروفائل پر فاؤنڈر بیج","شارة المؤسس على ملفك"],
    "Founder offer": ["فاؤنڈر آفر","عرض المؤسسين"],
    "Your founder spot is reserved.": ["آپ کی فاؤنڈر جگہ محفوظ ہے۔","مقعدك كمؤسس محجوز."],
    "You already have the Founder Membership. Choose another plan to renew.": ["آپ کے پاس فاؤنڈر ممبرشپ پہلے سے ہے۔ تجدید کے لیے کوئی اور پلان منتخب کریں۔","لديك عضوية المؤسسين بالفعل. اختر خطة أخرى للتجديد."],
    "1 Sign in": ["1 لاگ اِن","1 تسجيل الدخول"],
    "2 Profile": ["2 پروفائل","2 الملف"],
    "3 Payment": ["3 ادائیگی","3 الدفع"],
    "A backup is already running": ["بیک اپ پہلے ہی چل رہا ہے","هناك نسخة احتياطية قيد التشغيل بالفعل"],
    "A different admin must decide this appeal.": ["اس اپیل کا فیصلہ کوئی دوسرا ایڈمن کرے گا۔","يجب أن يبت مسؤول آخر في هذا الاعتراض."],
    "A different reviewer will look at it. You will get a notification with the decision.": ["کوئی دوسرا جائزہ لینے والا اسے دیکھے گا۔ فیصلے کی اطلاع آپ کو ملے گی۔","سيراجعه مراجع آخر وسيصلك إشعار بالقرار."],
    "A different reviewer will read this. You will get a notification with the decision. You can appeal the same decision again only after 30 days.": ["کوئی دوسرا جائزہ لینے والا اسے پڑھے گا۔ فیصلے کی اطلاع آپ کو ملے گی۔ آپ اسی فیصلے کی دوبارہ اپیل صرف 30 دن بعد کر سکتے ہیں۔","سيقرأ هذا مراجع آخر وسيصلك إشعار بالقرار. يمكنك الاعتراض على القرار نفسه مرة أخرى بعد 30 يومًا فقط."],
    "A happy couple": ["ایک خوش جوڑا","زوجان سعيدان"],
    "A bride and groom standing together under a crescent moon and a heart": ["دلہا اور دلہن ہلال اور دل کے نیچے ساتھ کھڑے ہیں","عروسان يقفان معًا تحت هلال وقلب"],
    "A moderator hid your broker review because it did not follow our review rules. You can edit it and it will stay hidden until a moderator restores it.": ["ایک موڈریٹر نے آپ کا بروکر تبصرہ چھپا دیا کیونکہ وہ ہمارے اصولوں کے مطابق نہیں تھا۔ آپ اسے ایڈٹ کر سکتے ہیں، لیکن موڈریٹر بحال کرنے تک وہ چھپا رہے گا۔","أخفى أحد المشرفين مراجعتك للوسيط لأنها لا تتوافق مع قواعدنا. يمكنك تعديلها وستبقى مخفية حتى يعيدها مشرف."],
    "A payment is still being confirmed. Try again in a few minutes.": ["ایک ادائیگی کی تصدیق ہو رہی ہے۔ چند منٹ بعد دوبارہ کوشش کریں۔","لا يزال هناك دفع قيد التأكيد. حاول مرة أخرى بعد دقائق."],
    "About": ["تعارف","نبذة"],
    "Action": ["کارروائی","الإجراء"],
    "Activate your profile with a membership to search members.": ["ممبران تلاش کرنے کے لیے ممبرشپ سے اپنا پروفائل فعال کریں۔","فعّل ملفك بعضوية للبحث عن الأعضاء."],
    "Activate your profile with a membership to view members.": ["ممبران دیکھنے کے لیے ممبرشپ سے اپنا پروفائل فعال کریں۔","فعّل ملفك بعضوية لعرض الأعضاء."],
    "Admin access only": ["صرف ایڈمن کے لیے","للمسؤولين فقط"],
    "Admin only": ["صرف ایڈمن","للمسؤول فقط"],
    "Admin accounts can't be suspended": ["ایڈمن اکاؤنٹ معطل نہیں کیے جا سکتے","لا يمكن إيقاف حسابات المسؤولين"],
    "Admin accounts can't be warned or suspended": ["ایڈمن اکاؤنٹ کو تنبیہ یا معطل نہیں کیا جا سکتا","لا يمكن تحذير حسابات المسؤولين أو إيقافها"],
    "Admin panel": ["ایڈمن پینل","لوحة الإدارة"],
    "All actions": ["تمام کارروائیاں","كل الإجراءات"],
    "Amount": ["رقم","المبلغ"],
    "An administrator will review the last 20 messages of this conversation.": ["ایک ایڈمن اس گفتگو کے آخری 20 پیغامات دیکھے گا۔","سيراجع مسؤول آخر 20 رسالة من هذه المحادثة."],
    "Appeal not found": ["اپیل نہیں ملی","لم يتم العثور على الاعتراض"],
    "Appeals to review": ["جائزے کے لیے اپیلیں","اعتراضات للمراجعة"],
    "Apple did not share a verified email. In your Apple ID settings, stop using Sign in with Apple for this site, then try again.": ["ایپل نے تصدیق شدہ ای میل شیئر نہیں کی۔ اپنی Apple ID کی سیٹنگز میں اس سائٹ کے لیے Apple سے لاگ اِن بند کریں، پھر دوبارہ کوشش کریں۔","لم تشارك Apple بريدًا إلكترونيًا موثقًا. في إعدادات Apple ID أوقف استخدام «تسجيل الدخول عبر Apple» لهذا الموقع ثم حاول مجددًا."],
    "Apple sign-in did not complete. Please try again.": ["Apple سے لاگ اِن مکمل نہیں ہوا۔ دوبارہ کوشش کریں۔","لم يكتمل تسجيل الدخول عبر Apple. حاول مرة أخرى."],
    "Apple sign-in failed": ["Apple سے لاگ اِن ناکام","فشل تسجيل الدخول عبر Apple"],
    "Apple sign-in failed. The site owner can see the reason in the server log.": ["Apple سے لاگ اِن ناکام ہوا۔ سائٹ کا مالک وجہ سرور لاگ میں دیکھ سکتا ہے۔","فشل تسجيل الدخول عبر Apple. يمكن لمالك الموقع رؤية السبب في سجل الخادم."],
    "Apple sign-in is still loading. Try again in a moment.": ["Apple لاگ اِن ابھی لوڈ ہو رہا ہے۔ کچھ دیر بعد کوشش کریں۔","تسجيل الدخول عبر Apple قيد التحميل. حاول بعد لحظة."],
    "Application submitted": ["درخواست جمع ہو گئی","تم إرسال الطلب"],
    "Apply again": ["دوبارہ درخواست دیں","قدّم طلبًا مرة أخرى"],
    "Approve all": ["سب منظور کریں","الموافقة على الكل"],
    "Audit log": ["آڈٹ لاگ","سجل التدقيق"],
    "Audit rows": ["آڈٹ اندراجات","سجلات التدقيق"],
    "Back up now": ["ابھی بیک اپ لیں","انسخ احتياطيًا الآن"],
    "Backup failed:": ["بیک اپ ناکام:","فشل النسخ الاحتياطي:"],
    "Backup finished and verified": ["بیک اپ مکمل اور تصدیق شدہ","اكتمل النسخ الاحتياطي وتم التحقق منه"],
    "Backup started…": ["بیک اپ شروع ہو گیا…","بدأ النسخ الاحتياطي…"],
    "Backups": ["بیک اپ","النسخ الاحتياطية"],
    "Backups are not enabled. Set BACKUP_ENABLED=true and BACKUP_KEY in .env, then restart.": ["بیک اپ فعال نہیں ہیں۔ .env میں BACKUP_ENABLED=true اور BACKUP_KEY لگائیں، پھر دوبارہ شروع کریں۔","النسخ الاحتياطي غير مفعّل. اضبط BACKUP_ENABLED=true و BACKUP_KEY في ملف .env ثم أعد التشغيل."],
    "Bad request": ["غلط درخواست","طلب غير صالح"],
    "Broker": ["بروکر","وسيط"],
    "Broker applications": ["بروکر درخواستیں","طلبات الوسطاء"],
    "Broker not found": ["بروکر نہیں ملا","لم يتم العثور على الوسيط"],
    "Broker reviews": ["بروکر تبصرے","مراجعات الوسطاء"],
    "Brokers are reviewed by our team before they are listed or shown as Verified.": ["بروکرز کو فہرست میں شامل کرنے یا تصدیق شدہ دکھانے سے پہلے ہماری ٹیم جانچتی ہے۔","تراجع فريقنا الوسطاء قبل إدراجهم أو إظهارهم كموثقين."],
    "Choose": ["منتخب کریں","اختر"],
    "Choose a plan": ["پلان منتخب کریں","اختر خطة"],
    "Choose dismiss, warn or suspend": ["خارج کریں، تنبیہ کریں یا معطل کریں میں سے انتخاب کریں","اختر: رفض أو تحذير أو إيقاف"],
    "Choose overturn or uphold": ["الٹ دیں یا برقرار رکھیں میں سے انتخاب کریں","اختر: إلغاء القرار أو تأييده"],
    "Choose what happened": ["منتخب کریں کیا ہوا","اختر ما حدث"],
    "Complete every field.": ["ہر خانہ مکمل کریں۔","أكمل كل الحقول."],
    "Complete every field. Age must be 18 to 70.": ["ہر خانہ مکمل کریں۔ عمر 18 سے 70 کے درمیان ہونی چاہیے۔","أكمل كل الحقول. يجب أن يكون العمر بين 18 و70."],
    "Connect": ["جوڑیں","اتصال"],
    "Continue": ["جاری رکھیں","متابعة"],
    "Conversation not found": ["گفتگو نہیں ملی","لم يتم العثور على المحادثة"],
    "Conversation snapshot": ["گفتگو کا عکس","لقطة من المحادثة"],
    "Could not load the secure payment form. Check your connection and try again.": ["محفوظ ادائیگی فارم لوڈ نہیں ہو سکا۔ کنکشن چیک کر کے دوبارہ کوشش کریں۔","تعذر تحميل نموذج الدفع الآمن. تحقق من اتصالك وحاول مجددًا."],
    "Could not prepare your data. Try again.": ["آپ کا ڈیٹا تیار نہیں ہو سکا۔ دوبارہ کوشش کریں۔","تعذر تجهيز بياناتك. حاول مرة أخرى."],
    "Create your profile before paying": ["ادائیگی سے پہلے اپنا پروفائل بنائیں","أنشئ ملفك قبل الدفع"],
    "Date": ["تاریخ","التاريخ"],
    "Delete your account for good? This cannot be undone.": ["اپنا اکاؤنٹ ہمیشہ کے لیے حذف کریں؟ اسے واپس نہیں کیا جا سکتا۔","حذف حسابك نهائيًا؟ لا يمكن التراجع عن ذلك."],
    "Delete your review?": ["اپنا تبصرہ حذف کریں؟","حذف مراجعتك؟"],
    "Detail": ["تفصیل","التفصيل"],
    "Details": ["تفصیلات","التفاصيل"],
    "Dismiss": ["خارج کریں","رفض"],
    "Email not verified": ["ای میل کی تصدیق نہیں ہوئی","البريد الإلكتروني غير موثق"],
    "Enter a note for the record": ["ریکارڈ کے لیے نوٹ لکھیں","اكتب ملاحظة للسجل"],
    "Enter a note. The member will see it.": ["نوٹ لکھیں۔ ممبر اسے دیکھے گا۔","اكتب ملاحظة. سيراها العضو."],
    "Enter a reason": ["وجہ لکھیں","اكتب السبب"],
    "Enter a reason.": ["وجہ لکھیں۔","اكتب السبب."],
    "Enter a reason for revoking": ["منسوخ کرنے کی وجہ لکھیں","اكتب سبب السحب"],
    "Enter a reason for suspending": ["معطل کرنے کی وجہ لکھیں","اكتب سبب الإيقاف"],
    "Enter a refund reason": ["رقم واپسی کی وجہ لکھیں","اكتب سبب الاسترداد"],
    "Experience (for example 5 years)": ["تجربہ (مثلاً 5 سال)","الخبرة (مثلاً 5 سنوات)"],
    "Export CSV": ["CSV ایکسپورٹ کریں","تصدير CSV"],
    "Exported the newest 50,000 entries. Narrow the filters to get the rest.": ["تازہ ترین 50,000 اندراجات ایکسپورٹ ہوئے۔ باقی کے لیے فلٹر محدود کریں۔","تم تصدير أحدث 50,000 سجل. ضيّق المرشحات للحصول على الباقي."],
    "Filter": ["فلٹر","تصفية"],
    "Global": ["عالمی","عالمي"],
    "Google sign-in could not load. Check your connection.": ["Google لاگ اِن لوڈ نہیں ہو سکا۔ کنکشن چیک کریں۔","تعذر تحميل تسجيل الدخول عبر Google. تحقق من اتصالك."],
    "Google sign-in failed. The site owner can see the reason in the server log.": ["Google سے لاگ اِن ناکام ہوا۔ سائٹ کا مالک وجہ سرور لاگ میں دیکھ سکتا ہے۔","فشل تسجيل الدخول عبر Google. يمكن لمالك الموقع رؤية السبب في سجل الخادم."],
    "Hide this review? Enter a reason:": ["یہ تبصرہ چھپائیں؟ وجہ لکھیں:","إخفاء هذه المراجعة؟ اكتب السبب:"],
    "How": ["کیسے","كيف"],
    "Languages": ["زبانیں","اللغات"],
    "Looking for:": ["تلاش:","يبحث عن:"],
    "Main": ["مرکزی","الرئيسية"],
    "Member": ["ممبر","عضو"],
    "Member not found": ["ممبر نہیں ملا","لم يتم العثور على العضو"],
    "Members": ["ممبران","الأعضاء"],
    "Member photo": ["ممبر کی تصویر","صورة العضو"],
    "New appeal to review": ["جائزے کے لیے نئی اپیل","اعتراض جديد للمراجعة"],
    "No applications yet.": ["ابھی کوئی درخواست نہیں۔","لا توجد طلبات بعد."],
    "No conversation attached.": ["کوئی گفتگو منسلک نہیں۔","لا توجد محادثة مرفقة."],
    "No members yet.": ["ابھی کوئی ممبر نہیں۔","لا يوجد أعضاء بعد."],
    "No open appeals.": ["کوئی کھلی اپیل نہیں۔","لا توجد اعتراضات مفتوحة."],
    "No open reports.": ["کوئی کھلی رپورٹ نہیں۔","لا توجد بلاغات مفتوحة."],
    "No photo": ["تصویر نہیں","لا توجد صورة"],
    "No reviews yet.": ["ابھی کوئی تبصرہ نہیں۔","لا توجد مراجعات بعد."],
    "No transactions yet.": ["ابھی کوئی لین دین نہیں۔","لا توجد معاملات بعد."],
    "No verified members yet.": ["ابھی کوئی تصدیق شدہ ممبر نہیں۔","لا يوجد أعضاء موثقون بعد."],
    "Not found": ["نہیں ملا","غير موجود"],
    "Note": ["نوٹ","ملاحظة"],
    "Only approved brokers can be suspended": ["صرف منظور شدہ بروکرز کو معطل کیا جا سکتا ہے","لا يمكن إيقاف إلا الوسطاء المعتمدين"],
    "Only paid payments can be refunded": ["صرف ادا شدہ ادائیگیاں واپس کی جا سکتی ہیں","لا يمكن استرداد إلا المدفوعات المكتملة"],
    "Open the Broker account tab to see the reason and apply again.": ["وجہ دیکھنے اور دوبارہ درخواست دینے کے لیے بروکر اکاؤنٹ ٹیب کھولیں۔","افتح تبويب حساب الوسيط لرؤية السبب وإعادة التقديم."],
    "Original decision by": ["اصل فیصلہ از","القرار الأصلي من"],
    "Outcome": ["نتیجہ","النتيجة"],
    "Pay": ["ادا کریں","ادفع"],
    "Pay by mada, Visa or Mastercard through Moyasar. We never see your card number. See the": ["مدا، ویزا یا ماسٹر کارڈ سے Moyasar کے ذریعے ادا کریں۔ ہم آپ کا کارڈ نمبر کبھی نہیں دیکھتے۔ دیکھیں","ادفع بمدى أو فيزا أو ماستركارد عبر Moyasar. لا نرى رقم بطاقتك أبدًا. راجع"],
    "Payment records are kept without your email, as the law requires. This cannot be undone.": ["قانون کے مطابق ادائیگی کا ریکارڈ آپ کی ای میل کے بغیر محفوظ رہتا ہے۔ اسے واپس نہیں کیا جا سکتا۔","تُحفظ سجلات الدفع دون بريدك الإلكتروني كما يقتضي القانون. لا يمكن التراجع عن ذلك."],
    "Payments and transactions": ["ادائیگیاں اور لین دین","المدفوعات والمعاملات"],
    "Photo of": ["تصویر:","صورة"],
    "Plan": ["پلان","الخطة"],
    "Please accept the Terms and the Privacy Policy to continue.": ["جاری رکھنے کے لیے شرائط اور پرائیویسی پالیسی قبول کریں۔","يرجى قبول الشروط وسياسة الخصوصية للمتابعة."],
    "Please choose a JPEG photo (at least 64 pixels wide).": ["JPEG تصویر منتخب کریں (کم از کم 64 پکسل چوڑی)۔","اختر صورة JPEG (عرضها 64 بكسل على الأقل)."],
    "Please explain in at least 20 characters why this decision should be reviewed.": ["کم از کم 20 حروف میں بتائیں کہ اس فیصلے پر نظرِ ثانی کیوں ہونی چاہیے۔","اشرح في 20 حرفًا على الأقل سبب وجوب مراجعة هذا القرار."],
    "Reason": ["وجہ","السبب"],
    "Reason for revoking verification:": ["تصدیق منسوخ کرنے کی وجہ:","سبب سحب التوثيق:"],
    "Recently decided": ["حال ہی میں فیصلہ شدہ","تم البت فيها مؤخرًا"],
    "Recently resolved": ["حال ہی میں حل شدہ","تمت معالجتها مؤخرًا"],
    "Recipient not found": ["وصول کنندہ نہیں ملا","لم يتم العثور على المستلم"],
    "Refund failed:": ["رقم واپسی ناکام:","فشل الاسترداد:"],
    "Refund sent": ["رقم واپس بھیج دی گئی","تم إرسال المبلغ المسترد"],
    "Reinstate": ["بحال کریں","إعادة التفعيل"],
    "Remove from shortlist": ["شارٹ لسٹ سے ہٹائیں","إزالة من القائمة المختصرة"],
    "Remove your photo?": ["اپنی تصویر ہٹائیں؟","إزالة صورتك؟"],
    "Removed from shortlist": ["شارٹ لسٹ سے ہٹا دیا گیا","تمت الإزالة من القائمة المختصرة"],
    "Report not found": ["رپورٹ نہیں ملی","لم يتم العثور على البلاغ"],
    "Reported by": ["رپورٹ کنندہ","المُبلِّغ"],
    "Reports to review": ["جائزے کے لیے رپورٹس","بلاغات للمراجعة"],
    "Result": ["نتیجہ","النتيجة"],
    "Review": ["تبصرہ","مراجعة"],
    "Review not found": ["تبصرہ نہیں ملا","لم يتم العثور على المراجعة"],
    "Reviewer note": ["جائزہ لینے والے کا نوٹ","ملاحظة المراجع"],
    "Right-aligned messages were sent by the reporter.": ["دائیں جانب والے پیغامات رپورٹ کرنے والے نے بھیجے۔","الرسائل على اليمين أرسلها المُبلِّغ."],
    "Rishta": ["رشتہ","زواج"],
    "Rishta Connect Global": ["رشتہ کنیکٹ گلوبل","Rishta Connect Global"],
    "Rishta Connect Global logo": ["رشتہ کنیکٹ گلوبل کا لوگو","شعار Rishta Connect Global"],
    "Say briefly what is wrong with this review.": ["مختصراً بتائیں اس تبصرے میں کیا خرابی ہے۔","اذكر باختصار ما الخطأ في هذه المراجعة."],
    "Search target or reason": ["ہدف یا وجہ تلاش کریں","ابحث عن الهدف أو السبب"],
    "Sign in required": ["لاگ اِن ضروری ہے","تسجيل الدخول مطلوب"],
    "Sign-in expired. Please try again.": ["لاگ اِن کی مدت ختم ہو گئی۔ دوبارہ کوشش کریں۔","انتهت صلاحية تسجيل الدخول. حاول مرة أخرى."],
    "Signed in as": ["لاگ اِن بطور","تم تسجيل الدخول باسم"],
    "Size": ["سائز","الحجم"],
    "Something went wrong. Try again.": ["کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔","حدث خطأ ما. حاول مرة أخرى."],
    "Specialization": ["مہارت","التخصص"],
    "Started": ["شروع ہوا","بدأ"],
    "Status": ["حالت","الحالة"],
    "Successful": ["کامیاب","ناجح"],
    "Suspend an approved broker instead": ["اس کے بجائے منظور شدہ بروکر کو معطل کریں","أوقف وسيطًا معتمدًا بدلًا من ذلك"],
    "Suspend member": ["ممبر کو معطل کریں","إيقاف العضو"],
    "Target": ["ہدف","الهدف"],
    "That picture is too small. Choose one at least 64 pixels wide.": ["یہ تصویر بہت چھوٹی ہے۔ کم از کم 64 پکسل چوڑی تصویر منتخب کریں۔","الصورة صغيرة جدًا. اختر صورة عرضها 64 بكسل على الأقل."],
    "The log is append-only: entries cannot be edited or deleted through the app. Export uses the filters you last applied, and each export is recorded here.": ["یہ لاگ صرف اضافے کے لیے ہے: اندراجات ایپ سے ایڈٹ یا حذف نہیں ہو سکتے۔ ایکسپورٹ آپ کے آخری فلٹر استعمال کرتا ہے اور ہر ایکسپورٹ یہاں درج ہوتا ہے۔","السجل للإضافة فقط: لا يمكن تعديل السجلات أو حذفها عبر التطبيق. يستخدم التصدير آخر مرشحات طبقتها ويُسجَّل كل تصدير هنا."],
    "The member is not told who reported them.": ["ممبر کو نہیں بتایا جاتا کہ رپورٹ کس نے کی۔","لا يُخبَر العضو بمن أبلغ عنه."],
    "The queue is clear.": ["قطار خالی ہے۔","لا توجد عناصر في قائمة الانتظار."],
    "This appeal was already decided": ["اس اپیل کا فیصلہ پہلے ہو چکا ہے","تم البت في هذا الاعتراض مسبقًا"],
    "This email is linked to a different Apple account.": ["یہ ای میل کسی اور Apple اکاؤنٹ سے منسلک ہے۔","هذا البريد مرتبط بحساب Apple آخر."],
    "This is your own review.": ["یہ آپ کا اپنا تبصرہ ہے۔","هذه مراجعتك."],
    "This member is unavailable.": ["یہ ممبر دستیاب نہیں۔","هذا العضو غير متاح."],
    "This permanently removes your profile, photo, messages and shortlist.": ["اس سے آپ کا پروفائل، تصویر، پیغامات اور شارٹ لسٹ ہمیشہ کے لیے ہٹ جائیں گے۔","سيؤدي هذا إلى إزالة ملفك وصورتك ورسائلك وقائمتك المختصرة نهائيًا."],
    "This report was already resolved": ["یہ رپورٹ پہلے ہی حل ہو چکی ہے","تمت معالجة هذا البلاغ مسبقًا"],
    "Too many appeals. Try again later.": ["بہت زیادہ اپیلیں۔ بعد میں کوشش کریں۔","اعتراضات كثيرة جدًا. حاول لاحقًا."],
    "Too many photo uploads. Try again later.": ["تصاویر بہت زیادہ اپ لوڈ ہوئیں۔ بعد میں کوشش کریں۔","عمليات رفع صور كثيرة جدًا. حاول لاحقًا."],
    "Too many reports. Try again later.": ["بہت زیادہ رپورٹس۔ بعد میں کوشش کریں۔","بلاغات كثيرة جدًا. حاول لاحقًا."],
    "Type DELETE to confirm.": ["تصدیق کے لیے DELETE لکھیں۔","اكتب DELETE للتأكيد."],
    "Unknown appeal type": ["اپیل کی نامعلوم قسم","نوع اعتراض غير معروفة"],
    "Unknown check": ["نامعلوم جانچ","فحص غير معروف"],
    "Upload a photo first.": ["پہلے تصویر اپ لوڈ کریں۔","ارفع صورة أولاً."],
    "Verification queue": ["تصدیق کی قطار","قائمة التوثيق"],
    "Verified members": ["تصدیق شدہ ممبران","الأعضاء الموثقون"],
    "Warn member": ["ممبر کو تنبیہ کریں","تحذير العضو"],
    "Warning not found": ["تنبیہ نہیں ملی","لم يتم العثور على التحذير"],
    "Warning:": ["تنبیہ:","تحذير:"],
    "We could not prepare that picture.": ["ہم وہ تصویر تیار نہیں کر سکے۔","تعذر تجهيز تلك الصورة."],
    "We could not read that picture. Please choose a JPEG or PNG photo.": ["ہم وہ تصویر پڑھ نہیں سکے۔ JPEG یا PNG تصویر منتخب کریں۔","تعذر قراءة تلك الصورة. اختر صورة JPEG أو PNG."],
    "We received your appeal": ["ہمیں آپ کی اپیل مل گئی","استلمنا اعتراضك"],
    "What is wrong with this review?": ["اس تبصرے میں کیا خرابی ہے؟","ما الخطأ في هذه المراجعة؟"],
    "When": ["کب","متى"],
    "Write a message first": ["پہلے پیغام لکھیں","اكتب رسالة أولاً"],
    "You already have an appeal waiting for review.": ["آپ کی ایک اپیل پہلے سے جائزے کے انتظار میں ہے۔","لديك اعتراض بانتظار المراجعة بالفعل."],
    "You already have an open report for this member. We will review it soon.": ["اس ممبر کے خلاف آپ کی رپورٹ پہلے سے کھلی ہے۔ ہم جلد جائزہ لیں گے۔","لديك بلاغ مفتوح عن هذا العضو بالفعل. سنراجعه قريبًا."],
    "You are sending messages too fast. Wait a moment.": ["آپ بہت تیزی سے پیغام بھیج رہے ہیں۔ ذرا انتظار کریں۔","ترسل الرسائل بسرعة كبيرة. انتظر قليلًا."],
    "You can appeal from the Broker account tab.": ["آپ بروکر اکاؤنٹ ٹیب سے اپیل کر سکتے ہیں۔","يمكنك الاعتراض من تبويب حساب الوسيط."],
    "You can't block yourself": ["آپ خود کو بلاک نہیں کر سکتے","لا يمكنك حظر نفسك"],
    "You can't report yourself": ["آپ خود کی رپورٹ نہیں کر سکتے","لا يمكنك الإبلاغ عن نفسك"],
    "You have a new review": ["آپ کو نیا تبصرہ ملا ہے","لديك مراجعة جديدة"],
    "You have not reviewed this broker.": ["آپ نے اس بروکر کا تبصرہ نہیں کیا۔","لم تراجع هذا الوسيط."],
    "You:": ["آپ:","أنت:"],
    "Your account is not suspended.": ["آپ کا اکاؤنٹ معطل نہیں ہے۔","حسابك غير موقوف."],
    "Your account is suspended. Contact support for help.": ["آپ کا اکاؤنٹ معطل ہے۔ مدد کے لیے سپورٹ سے رابطہ کریں۔","حسابك موقوف. تواصل مع الدعم للمساعدة."],
    "Your account is suspended. Contact support.": ["آپ کا اکاؤنٹ معطل ہے۔ سپورٹ سے رابطہ کریں۔","حسابك موقوف. تواصل مع الدعم."],
    "Your appeal is under review.": ["آپ کی اپیل زیرِ جائزہ ہے۔","اعتراضك قيد المراجعة."],
    "Your broker account is": ["آپ کا بروکر اکاؤنٹ ہے","حساب الوسيط الخاص بك"],
    "Your broker account is active": ["آپ کا بروکر اکاؤنٹ فعال ہے","حساب الوسيط الخاص بك فعّال"],
    "Your broker account is approved and listed.": ["آپ کا بروکر اکاؤنٹ منظور ہو کر فہرست میں شامل ہے۔","تمت الموافقة على حساب الوسيط الخاص بك وإدراجه."],
    "Your broker account is not suspended.": ["آپ کا بروکر اکاؤنٹ معطل نہیں ہے۔","حساب الوسيط الخاص بك غير موقوف."],
    "Your broker account was suspended": ["آپ کا بروکر اکاؤنٹ معطل کر دیا گیا","تم إيقاف حساب الوسيط الخاص بك"],
    "Your broker application was not approved": ["آپ کی بروکر درخواست منظور نہیں ہوئی","لم تتم الموافقة على طلب الوسيط الخاص بك"],
    "Your photo was removed": ["آپ کی تصویر ہٹا دی گئی","تمت إزالة صورتك"],
    "Your profile is awaiting approval.": ["آپ کا پروفائل منظوری کا منتظر ہے۔","ملفك بانتظار الموافقة."],
    "Your profile is not active yet. Complete payment to activate it.": ["آپ کا پروفائل ابھی فعال نہیں۔ فعال کرنے کے لیے ادائیگی مکمل کریں۔","ملفك غير مفعّل بعد. أكمل الدفع لتفعيله."],
    "Your remaining membership time is not refunded.": ["آپ کی باقی ممبرشپ مدت کی رقم واپس نہیں ہوگی۔","لا يُسترد المبلغ عن المدة المتبقية من عضويتك."],
    "Your review was hidden": ["آپ کا تبصرہ چھپا دیا گیا","تم إخفاء مراجعتك"],
    "Your shortlist is full (200).": ["آپ کی شارٹ لسٹ بھر چکی ہے (200)۔","قائمتك المختصرة ممتلئة (200)."],
    "active warning": ["فعال تنبیہ","تحذير نشط"],
    "month": ["ماہ","شهر"],
    "securely": ["محفوظ طریقے سے","بأمان"],
    "for refunds.": ["رقم واپسی کے لیے۔","للاطلاع على المبالغ المستردة."]
  };

  const LANGS = { en: { dir: 'ltr', name: 'English' }, ur: { dir: 'rtl', name: 'اردو', i: 0 }, ar: { dir: 'rtl', name: 'العربية', i: 1 } };
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const LATIN = /[A-Za-z]{2}/;                 // only text that still contains English words needs work
  const SKIP = 'script,style,noscript,textarea,input,code,pre,select.lang,.b,.chat,[data-notr],[translate="no"],.notranslate';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const PUNCT = { ur: { '.': '۔', '?': '؟', ',': '،' }, ar: { '?': '؟', ',': '،' } };

  /* ---------------------------------------------------------------- 2. patterns ----------------- */
  // Each: regex, then one function per language. (m = regex match, T = translate a fragment, leaving it as is if unknown)
  const PATTERNS = [
    { re: /^Founder #(\d+)$/, ur: m => `فاؤنڈر نمبر ${m[1]}`, ar: m => `المؤسس رقم ${m[1]}` },
    { re: /^(\d+) of (\d+) founder spots left$/, ur: m => `فاؤنڈر کی ${m[2]} میں سے ${m[1]} جگہیں باقی`, ar: m => `بقي ${m[1]} من ${m[2]} مقعدًا للمؤسسين` },
    { re: /^Founder Membership is only for the first (\d+) members who signed up\.$/, ur: m => `فاؤنڈر ممبرشپ صرف سائن اپ کرنے والے پہلے ${m[1]} ممبران کے لیے ہے۔`, ar: m => `عضوية المؤسسين لأول ${m[1]} عضوًا سجّلوا فقط.` },
    { re: /^Choose (.+)$/, ur: (m, T) => `${T(m[1])} منتخب کریں`, ar: (m, T) => `اختر ${T(m[1])}` },
    { re: /^(\d+) members? found$/, ur: m => `${m[1]} ممبران ملے`, ar: m => `تم العثور على ${m[1]} عضو` },
    { re: /^Page (\d+) of (\d+)$/, ur: m => `صفحہ ${m[1]} از ${m[2]}`, ar: m => `صفحة ${m[1]} من ${m[2]}` },
    { re: /^Pay (\S+) (\w+) securely$/, ur: m => `${m[1]} ${m[2]} محفوظ طریقے سے ادا کریں`, ar: m => `ادفع ${m[1]} ${m[2]} بأمان` },
    { re: /^(\d+) reviews?$/, ur: m => m[1] == 1 ? '1 تبصرہ' : `${m[1]} تبصرے`, ar: m => m[1] == 1 ? 'مراجعة واحدة' : `${m[1]} مراجعات` },
    { re: /^(\d+) reports?$/, ur: m => `${m[1]} رپورٹ`, ar: m => `${m[1]} بلاغ` },
    { re: /^(\d+) active warnings?$/, ur: m => `${m[1]} فعال تنبیہ`, ar: m => `${m[1]} تحذير نشط` },
    { re: /^(\d+) yrs?$/, ur: m => `${m[1]} سال`, ar: m => `${m[1]} سنة` },
    { re: /^(\d+) months?$/, ur: m => `${m[1]} ماہ`, ar: m => `${m[1]} شهر` },
    { re: /^(.+) active until (.+)$/, ur: (m, T) => `${T(m[1])} ${m[2]} تک فعال ہے`, ar: (m, T) => `${T(m[1])} فعّالة حتى ${m[2]}` },
    { re: /^Signed in as (.+)$/, ur: m => `${m[1]} کے طور پر لاگ اِن`, ar: m => `تم تسجيل الدخول باسم ${m[1]}` },
    { re: /^Suspend (.+)\? Enter a reason:$/, ur: m => `${m[1]} کو معطل کریں؟ وجہ لکھیں:`, ar: m => `إيقاف ${m[1]}؟ اكتب السبب:` },
    { re: /^Reject (.+)\? Enter a reason:$/, ur: m => `${m[1]} کی درخواست مسترد کریں؟ وجہ لکھیں:`, ar: m => `رفض ${m[1]}؟ اكتب السبب:` },
    { re: /^Block (.+)\? You will no longer see each other in search or be able to message\.$/, ur: m => `${m[1]} کو بلاک کریں؟ آپ ایک دوسرے کو تلاش میں نہیں دیکھ سکیں گے اور پیغام نہیں بھیج سکیں گے۔`, ar: m => `حظر ${m[1]}؟ لن ترى أحدكما الآخر في البحث ولن تتمكنا من المراسلة.` },
    { re: /^Refund (\S+) (\w+) to (.+)\? Enter a reason:$/, ur: m => `${m[3]} کو ${m[1]} ${m[2]} واپس کریں؟ وجہ لکھیں:`, ar: m => `استرداد ${m[1]} ${m[2]} إلى ${m[3]}؟ اكتب السبب:` },
    { re: /^Remove the photo of (.+)\? Enter a reason \(the member will see it\):$/, ur: m => `${m[1]} کی تصویر ہٹائیں؟ وجہ لکھیں (ممبر اسے دیکھے گا):`, ar: m => `إزالة صورة ${m[1]}؟ اكتب السبب (سيراه العضو):` },
    { re: /^Your earlier appeal was decided less than (\d+) days ago\.$/, ur: m => `آپ کی پچھلی اپیل کا فیصلہ ${m[1]} دن سے کم پہلے ہوا تھا۔`, ar: m => `صدر القرار في اعتراضك السابق منذ أقل من ${m[1]} يومًا.` },
    { re: /^A member rated you (\d) out of 5\. Open your broker page to read it\.$/, ur: m => `ایک ممبر نے آپ کو 5 میں سے ${m[1]} ریٹنگ دی۔ پڑھنے کے لیے اپنا بروکر پیج کھولیں۔`, ar: m => `قيّمك أحد الأعضاء بـ ${m[1]} من 5. افتح صفحة الوسيط لقراءة المراجعة.` },
    { re: /^A member appealed a (.+) decision \(appeal #(\d+)\)\. Open the admin panel to review it\.$/, ur: (m, T) => `ایک ممبر نے ${T(m[1])} کے فیصلے کی اپیل کی (اپیل نمبر ${m[2]})۔ دیکھنے کے لیے ایڈمن پینل کھولیں۔`, ar: (m, T) => `اعترض أحد الأعضاء على قرار ${T(m[1])} (اعتراض رقم ${m[2]}). افتح لوحة الإدارة لمراجعته.` },
    { re: /^Our team removed your profile photo because it did not follow the rules \((.+)\)\.$/, ur: m => `ہماری ٹیم نے آپ کی پروفائل تصویر اس لیے ہٹا دی کہ وہ اصولوں کے مطابق نہیں تھی (${m[1]})۔`, ar: m => `أزال فريقنا صورة ملفك لأنها لا تتوافق مع القواعد (${m[1]}).` },
  ];

  /* ---------------------------------------------------------------- 3. lookup -------------------- */
  const cur = () => { try { return typeof lang !== 'undefined' ? lang : (document.documentElement.lang || 'en'); } catch (e) { return 'en'; } };
  const idx = code => (LANGS[code] && LANGS[code].i);
  const missing = new Set();

  /** Translate one already-normalised string. Returns the translation, or null when it is not known. */
  function tr(t, code) {
    const i = idx(code); if (i === undefined || !t) return null;
    const e = DICT[t]; if (e && e[i]) return e[i];
    for (const p of PATTERNS) { const m = p.re.exec(t); if (m && p[code]) { let r = p[code](m, s => tr(norm(s), code) || s); if (r) return code === 'ar' ? r.replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]) : r; } }
    let m;
    // "Label (3)"  ->  translated label + the number
    if ((m = /^(.+?)\s*\((\d+)\)$/.exec(t))) { const h = tr(m[1], code); if (h) return `${h} (${m[2]})`; }
    // trailing punctuation: "Warning:" "Done." "Really?"
    if ((m = /^(.*[^\s.:!?…,;])\s*([.:!?…,;]+)$/.exec(t))) {
      const h = tr(m[1], code); if (h) return h + m[2].replace(/[.?,]/g, c => (PUNCT[code] && PUNCT[code][c]) || c);
    }
    // "Label: value" and "a · b · c": translate the parts that are known
    if (t.includes(' · ')) { const ps = t.split(' · '), out = ps.map(s => tr(s, code)); if (out.some(Boolean)) return ps.map((s, k) => out[k] || s).join(' · '); }
    if ((m = /^([^:]{2,60}): (.+)$/.exec(t))) { const a = tr(m[1], code); if (a) return `${a}: ${tr(m[2], code) || m[2]}`; }
    return null;
  }
  const translate = (text, code) => { const t = norm(text); return t ? (tr(t, code || cur()) || null) : null; };

  /* ---------------------------------------------------------------- 4. walker ------------------- */
  const textRec = new WeakMap(), attrRec = new WeakMap();   // what we changed, so it can be undone

  function doText(n, code) {
    const raw = n.nodeValue, rec = textRec.get(n), ours = rec && raw === rec.out, src = ours ? rec.src : raw;
    if (code === 'en') { if (ours) { n.nodeValue = rec.src; textRec.delete(n); } return; }
    if (rec && !ours) textRec.delete(n);                       // the page rewrote it: start again from the new text
    if (!LATIN.test(src) || (n.parentElement && n.parentElement.closest(SKIP))) return;
    const t = norm(src), h = tr(t, code);
    if (!h) { if (missing.size < 3000) missing.add(t); return; }
    const out = src.match(/^\s*/)[0] + h + src.match(/\s*$/)[0];
    n.nodeValue = out; textRec.set(n, { src, out });
  }
  function doAttr(el, a, code) {
    let r = attrRec.get(el); if (!r) attrRec.set(el, r = {});
    const raw = el.getAttribute(a); if (raw == null) return;
    const rec = r[a], ours = rec && raw === rec.out, src = ours ? rec.src : raw;
    if (code === 'en') { if (ours) { el.setAttribute(a, rec.src); delete r[a]; } return; }
    if (rec && !ours) delete r[a];
    if (!LATIN.test(src) || el.closest('[data-notr],[translate="no"],.notranslate,script,style')) return;   // inputs keep their own placeholders translated
    const h = tr(norm(src), code);
    if (!h) { if (missing.size < 3000) missing.add(norm(src)); return; }
    el.setAttribute(a, h); r[a] = { src, out: h };
  }
  function doElement(el, code) {
    for (const a of ATTRS) if (el.hasAttribute && el.hasAttribute(a)) doAttr(el, a, code);
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && el.hasAttribute('value')) doAttr(el, 'value', code);
  }
  /** Visit a node and everything inside it. */
  function walk(root, code) {
    if (!root || !root.isConnected) return;
    if (root.nodeType === 3) return doText(root, code);
    if (root.nodeType !== 1) return;
    if (root.closest && root.closest('[data-notr],[translate="no"],.notranslate,script,style')) return;
    doElement(root, code);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n, code); else doElement(n, code); }
  }
  function pageChrome(code) {
    const L = LANGS[code] || LANGS.en;
    if (document.documentElement.lang !== code) document.documentElement.lang = code;
    if (document.documentElement.dir !== L.dir) document.documentElement.dir = L.dir;
    // the browser tab title and the search-engine description
    if (!pageChrome.t) pageChrome.t = document.title;
    const d = document.querySelector('meta[name="description"]'); if (d && !pageChrome.d) pageChrome.d = d.content;
    document.title = ((code !== 'en' && tr(norm(pageChrome.t), code)) || pageChrome.t).trim();
    if (d) d.content = (code !== 'en' && tr(norm(pageChrome.d || ''), code)) || pageChrome.d || d.content;
  }
  /** Translate (or restore) the whole page. */
  function apply(root) {
    const code = cur();
    try { pageChrome(code); walk(root || document.body, code); } finally { if (obs) obs.takeRecords(); }
  }

  /* ---------------------------------------------------------------- 5. watcher ------------------- */
  let obs = null;
  function watch() {
    obs = new MutationObserver(recs => {
      const code = cur(); if (code === 'en') { obs.takeRecords(); return; }
      const nodes = new Set(), attrs = new Set();
      for (const r of recs) {
        if (r.type === 'childList') r.addedNodes.forEach(n => nodes.add(n));
        else if (r.type === 'characterData') nodes.add(r.target);
        else if (r.type === 'attributes') attrs.add(r.target);
      }
      nodes.forEach(n => walk(n, code));
      attrs.forEach(el => { if (el.isConnected) doElement(el, code); });
      obs.takeRecords();                                       // ignore the changes we just made ourselves
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat('value') });
  }

  /* ---------------------------------------------------------------- 6. browser dialogs ----------- */
  for (const k of ['alert', 'confirm', 'prompt']) {
    const orig = window[k]; if (typeof orig !== 'function') continue;
    window[k] = function (msg, ...rest) {
      const code = cur();
      if (code !== 'en' && typeof msg === 'string') { const h = translate(msg, code); if (h) msg = h; }
      return orig.call(window, msg, ...rest);
    };
  }

  /* ---------------------------------------------------------------- 7. public API ---------------- */
  window.I18N = {
    dict: DICT, langs: LANGS, translate,
    apply, trApply: apply,
    add(entries) { Object.assign(DICT, entries); },
    missing() { return [...missing].sort(); },
  };
  window.trApply = apply;
  const start = () => { watch(); apply(); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
