const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const admin = require('firebase-admin');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Device-Key'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,OPTIONS'
  );

  if(req.method==='OPTIONS') return res.status(204).end();

  next();
});

let mongoClient;
let db;
let firebaseAdmin;

async function getDb(){
  if(db) return db;

  if(!process.env.MONGODB_URI){
    throw new Error('MONGODB_URI is not configured');
  }

  mongoClient = new MongoClient(
    process.env.MONGODB_URI,
    {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000
    }
  );

  await mongoClient.connect();

  db = mongoClient.db(
    process.env.MONGODB_DB || 'smart_shop'
  );

  db.client = mongoClient;

  await ensureIndexes(db);

  return db;
}


/* =========================================================
   FIREBASE ADMIN
   ========================================================= */

function getFirebaseAdmin(){

  if(firebaseAdmin) return firebaseAdmin;

  const projectId = clean(
    process.env.FIREBASE_PROJECT_ID
  );

  const clientEmail = clean(
    process.env.FIREBASE_CLIENT_EMAIL
  );

  let privateKey =
    process.env.FIREBASE_PRIVATE_KEY || '';

  if(!projectId || !clientEmail || !privateKey){

    console.error(
      'Firebase Admin environment variables are missing.',
      {
        projectId: !!projectId,
        clientEmail: !!clientEmail,
        privateKey: !!privateKey
      }
    );

    return null;
  }

  privateKey = privateKey.trim();

  /*
     Vercel may contain the private key with literal \n
     characters. Convert them into real new lines.
  */

  if(
    (privateKey.startsWith('"') &&
     privateKey.endsWith('"')) ||

    (privateKey.startsWith("'") &&
     privateKey.endsWith("'"))
  ){
    privateKey = privateKey.slice(1,-1);
  }

  privateKey = privateKey.replace(/\\n/g,'\n');

  try{

    if(!admin.apps.length){

      admin.initializeApp({

        credential:
          admin.credential.cert({

            projectId: projectId,

            clientEmail: clientEmail,

            privateKey: privateKey

          })

      });

    }

    firebaseAdmin = admin;

    return firebaseAdmin;

  }catch(e){

    console.error(
      'Firebase Admin initialization failed:',
      e?.code || '',
      e?.message || e
    );

    return null;
  }
}


/* =========================================================
   DATABASE INDEXES
   ========================================================= */

async function ensureIndexes(database){

  await Promise.all([

    database.collection('users').createIndex(
      {firebaseUid:1},
      {unique:true,sparse:true}
    ),

    database.collection('users').createIndex(
      {phone:1}
    ),

    database.collection('products').createIndex(
      {shopId:1,barcode:1},
      {unique:true}
    ),

    database.collection('rfidAssignments').createIndex(
      {shopId:1,status:1,createdAt:1}
    ),

    database.collection('rfidInventory').createIndex(
      {shopId:1,rfidUid:1},
      {unique:true}
    ),

    database.collection('rfidInventory').createIndex(
      {shopId:1,barcode:1,status:1}
    ),

    database.collection('sales').createIndex(
      {shopId:1,createdAt:-1}
    ),

    database.collection('exitEvents').createIndex(
      {shopId:1,status:1,createdAt:-1}
    ),

    database.collection('exitEvents').createIndex(
      {eventId:1},
      {unique:true}
    )

  ]);
}


/* =========================================================
   HELPERS
   ========================================================= */

function clean(v){
  return v==null ? '' : String(v).trim();
}

function int(v,f=0){
  const n=Math.floor(Number(v));
  return Number.isFinite(n) ? n : f;
}

function num(v,f=0){
  const n=Number(
    String(v??'').replace(/,/g,'')
  );

  return Number.isFinite(n) ? n : f;
}

function uid(v){
  return clean(v)
    .replace(/[^A-Za-z0-9:_-]/g,'')
    .toUpperCase();
}

function shopMatch(shopId,shopName){

  const q={};

  if(shopId)
    q.shopId=shopId;

  else if(shopName)
    q.shopName=shopName;

  return q;
}

function ok(res,data={}){
  return res.status(200).json({
    ok:true,
    ...data
  });
}

function fail(
  res,
  error,
  status=400,
  extra={}
){
  return res.status(status).json({
    ok:false,
    error,
    ...extra
  });
}


/* =========================================================
   FIREBASE AUTHENTICATION
   ========================================================= */

async function authUser(
  req,
  {hardware=false}={}
){

  const key=clean(
    req.headers['x-device-key']
  );

  if(
    hardware &&
    process.env.DEVICE_API_KEY &&
    key===process.env.DEVICE_API_KEY
  ){
    return {device:true};
  }

  const token=clean(
    (req.headers.authorization||'')
      .replace(/^Bearer\s+/i,'')
  );

  const fa=getFirebaseAdmin();

  if(!fa){

    throw Object.assign(
      new Error(
        'Firebase Admin is not configured on the server.'
      ),
      {status:500}
    );
  }

  if(!token){

    throw Object.assign(
      new Error(
        'Authentication token is missing.'
      ),
      {status:401}
    );
  }

  /*
     IMPORTANT:
     Firebase token verification is kept separate
     from MongoDB user lookup.
  */

  let decoded;

  try{

    decoded =
      await fa.auth().verifyIdToken(token);

  }catch(e){

    console.error(
      'Firebase verifyIdToken failed:',
      e?.code || '',
      e?.message || e
    );

    throw Object.assign(
      new Error(
        'Invalid or expired Firebase session.'
      ),
      {status:401}
    );
  }


  /*
     MongoDB lookup is separate.
     Therefore a MongoDB error will no longer
     incorrectly appear as a Firebase error.
  */

  try{

    const database=await getDb();

    const u =
      await database
        .collection('users')
        .findOne({
          firebaseUid:decoded.uid
        });

    return {
      ...decoded,
      userId:u?.userId,
      shopId:u?.shopId,
      shopName:u?.shopName
    };

  }catch(e){

    console.error(
      'MongoDB user lookup failed:',
      e?.code || '',
      e?.message || e
    );

    throw Object.assign(
      new Error(
        'Database error while loading your account.'
      ),
      {status:500}
    );
  }
}


function canUseShop(actor,shopId){

  if(
    !actor ||
    actor.device ||
    actor.development
  ){
    return true;
  }

  return !actor.shopId ||
         actor.shopId===shopId;
}


/* =========================================================
   FIREBASE LOGIN
   ========================================================= */

async function loginFirebase(d){

  const database=await getDb();

  const phone=
    clean(d.phone);

  const email=
    clean(d.email).toLowerCase();

  const name=
    clean(d.name);

  const shopName=
    clean(d.shopName);

  const firebaseUid=
    clean(d.firebaseUid);

  if(!phone || !firebaseUid){

    return {
      ok:false,
      error:
        'Verified Firebase UID and phone are required.'
    };
  }

  const users=
    database.collection('users');

  let user=
    await users.findOne({
      $or:[
        {firebaseUid},
        {phone}
      ]
    });

  if(user){

    await users.updateOne(
      {_id:user._id},
      {
        $set:{
          name:
            name ||
            user.name ||
            'Shop Owner',

          email:
            email ||
            user.email ||
            '',

          phone,

          firebaseUid,

          lastLogin:new Date(),

          shopName:
            shopName ||
            user.shopName
        }
      }
    );

    user=
      await users.findOne({
        _id:user._id
      });

    return {
      ok:true,
      action:'login',
      user:publicUser(user)
    };
  }

  const doc={

    userId:
      'USR'+cryptoRandom(10),

    name:
      name || 'Shop Owner',

    email,

    phone,

    shopId:
      'SHOP'+cryptoRandom(8),

    shopName:
      shopName || 'New Shop',

    firebaseUid,

    exitCount:1,

    createdAt:new Date(),

    lastLogin:new Date()

  };

  await users.insertOne(doc);

  return {
    ok:true,
    action:'created',
    user:publicUser(doc)
  };
}


function cryptoRandom(n){

  const chars=
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  let s='';

  for(
    let i=0;
    i<n;
    i++
  ){

    s+=chars[
      Math.floor(
        Math.random()*chars.length
      )
    ];

  }

  return s;
}


function publicUser(u){

  return {

    userId:
      u.userId,

    name:
      u.name || 'Shop Owner',

    email:
      u.email || '',

    phone:
      u.phone || '',

    shopId:
      u.shopId,

    shopName:
      u.shopName || 'My Shop',

    exitCount:
      Math.max(
        1,
        int(u.exitCount,1)
      )

  };
}


/* =========================================================
   SAVE PRODUCT
   ========================================================= */

async function saveProduct(d,actor){

  const database=await getDb();

  const shopId=
    clean(d.shopId);

  const shopName=
    clean(d.shopName);

  const userId=
    clean(d.userId);

  const barcode=
    clean(d.barcode);

  const quantity=
    Math.max(
      1,
      int(d.quantity,1)
    );

  if(
    !shopId ||
    !userId ||
    !barcode
  ){

    return {
      ok:false,
      error:
        'Shop, user and barcode are required.'
    };
  }

  if(!canUseShop(actor,shopId)){

    return {
      ok:false,
      error:
        'You are not authorized for this shop.'
    };
  }

  const products=
    database.collection('products');

  const inv=
    database.collection('rfidInventory');

  const assignments=
    database.collection('rfidAssignments');

  const old=
    await products.findOne({
      shopId,
      barcode
    });

  const active=
    await inv.countDocuments({
      shopId,
      barcode,
      status:'ACTIVE'
    });

  if(
    old &&
    quantity<active
  ){

    return {
      ok:false,
      error:
        `Quantity cannot be lower than the number of active RFID tags already assigned (${active}). Remove/sell those units first.`
    };
  }

  const product = {
  shopId,
  shopName,
  userId,
  barcode,
  name: clean(d.name),
  brand: clean(d.brand),
  category: clean(d.category),
  mrp: clean(d.mrp),
  sellingPrice: clean(d.sellingPrice),
  manufacturingDate: clean(d.manufacturingDate),
  expiryDate: clean(d.expiryDate),
  quantity,
  rfidUid: old?.rfidUid || '',
  rfidStatus: active >= quantity ? 'ASSIGNED' : 'PENDING',
  barcodeSource: clean(d.barcodeSource) || 'camera',
  detailsSource: clean(d.detailsSource) || 'ocr',
  ocrText: clean(d.ocrText),
  updatedAt: new Date()
};

const { createdAt, ...productWithoutCreatedAt } = product;

await products.updateOne(
  { shopId, barcode },
  {
    $set: productWithoutCreatedAt,
    $setOnInsert: {
      createdAt: createdAt
    }
  },
  { upsert: true }
);

  const targetPending=
    Math.max(
      0,
      quantity-active
    );

  const pending=
    await assignments.countDocuments({
      shopId,
      barcode,
      status:'PENDING'
    });

  if(
    pending>targetPending
  ){

    const extra=
      await assignments
        .find({
          shopId,
          barcode,
          status:'PENDING'
        })
        .sort({
          createdAt:-1
        })
        .limit(
          pending-targetPending
        )
        .toArray();

    if(extra.length){

      await assignments.deleteMany({
        _id:{
          $in:
            extra.map(
              x=>x._id
            )
        }
      });

    }
  }

  const nowPending=
    await assignments.countDocuments({
      shopId,
      barcode,
      status:'PENDING'
    });

  if(
    nowPending<targetPending
  ){

    const docs=[];

    for(
      let i=nowPending;
      i<targetPending;
      i++
    ){

      docs.push({

        assignmentId:
          'ASN'+cryptoRandom(10),

        shopId,

        shopName,

        userId,

        barcode,

        productName:
          product.name,

        status:
          'PENDING',

        rfidUid:'',

        assignedAt:null,

        createdAt:
          new Date()

      });
    }

    if(docs.length)
      await assignments.insertMany(docs);
  }

  return {

    ok:true,

    action:
      old ? 'updated' : 'created',

    quantity,

    assignedRfids:
      active,

    remainingRfids:
      Math.max(
        0,
        quantity-active
      ),

    rfidRequired:
      active<quantity

  };
}


/* =========================================================
   RFID PENDING
   ========================================================= */

async function rfidPending(d){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  const shopName=
    clean(d.shopName);

  if(
    !shopId &&
    !shopName
  ){

    return {
      ok:false,
      error:
        'shopName or shopId required'
    };
  }

  const q=
    shopMatch(
      shopId,
      shopName
    );

  const a=
    await database
      .collection('rfidAssignments')
      .findOne(
        {
          ...q,
          status:'PENDING'
        },
        {
          sort:{
            createdAt:1
          }
        }
      );

  if(!a){

    const p=
      await database
        .collection('products')
        .find({
          ...q,
          quantity:{
            $gt:0
          }
        })
        .sort({
          updatedAt:-1
        })
        .limit(1)
        .toArray();

    const product=
      p[0];

    if(!product){

      return {
        ok:true,
        pending:false,
        quantity:0,
        assignedCount:0,
        remainingCount:0,
        barcode:''
      };
    }

    const active=
      await database
        .collection('rfidInventory')
        .countDocuments({
          shopId:
            product.shopId,
          barcode:
            product.barcode,
          status:'ACTIVE'
        });

    return {

      ok:true,

      pending:false,

      quantity:
        product.quantity,

      assignedCount:
        active,

      remainingCount:
        Math.max(
          0,
          product.quantity-active
        ),

      barcode:
        product.barcode

    };
  }

  const product=
    await database
      .collection('products')
      .findOne({
        shopId:a.shopId,
        barcode:a.barcode
      });

  const active=
    await database
      .collection('rfidInventory')
      .countDocuments({
        shopId:a.shopId,
        barcode:a.barcode,
        status:'ACTIVE'
      });

  const pendingCount=
    await database
      .collection('rfidAssignments')
      .countDocuments({
        shopId:a.shopId,
        barcode:a.barcode,
        status:'PENDING'
      });

  return {

    ok:true,

    pending:true,

    assignmentId:
      a.assignmentId,

    shopId:
      a.shopId,

    shopName:
      a.shopName,

    barcode:
      a.barcode,

    productName:
      a.productName,

    quantity:
      product?.quantity || 0,

    assignedCount:
      active,

    remainingCount:
      Math.max(
        0,
        (product?.quantity || 0)-active
      ),

    pendingCount

  };
}


/* =========================================================
   ASSIGN RFID
   ========================================================= */

async function assignRFID(d,actor){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  const shopName=
    clean(d.shopName);

  const aid=
    clean(d.assignmentId);

  const rfid=
    uid(d.rfidUid);

  if(
    !rfid ||
    (!shopId && !shopName)
  ){

    return {
      ok:false,
      error:
        'shopName/shopId and rfidUid required'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const assignments=
    database.collection(
      'rfidAssignments'
    );

  const products=
    database.collection(
      'products'
    );

  const inv=
    database.collection(
      'rfidInventory'
    );

  const q=
    aid
      ? {
          assignmentId:aid,
          status:'PENDING'
        }
      : {
          ...shopMatch(
            shopId,
            shopName
          ),
          status:'PENDING'
        };

  const a=
    await assignments.findOne(
      q,
      {
        sort:{
          createdAt:1
        }
      }
    );

  if(!a){

    return {
      ok:false,
      error:
        'No pending product assignment found for this shop.'
    };
  }

  const product=
    await products.findOne({
      shopId:a.shopId,
      barcode:a.barcode
    });

  if(!product){

    return {
      ok:false,
      error:
        'Product not found for this RFID assignment.'
    };
  }

  if(
    product.quantity<=0
  ){

    return {
      ok:false,
      error:
        'Product quantity is zero.'
    };
  }

  const duplicate=
    await inv.findOne({
      rfidUid:rfid
    });

  if(duplicate){

    return {
      ok:false,
      error:
        'This RFID tag is already assigned/used. Scan a different RFID tag.',
      rfidUid:rfid
    };
  }

  const active=
    await inv.countDocuments({
      shopId:a.shopId,
      barcode:a.barcode,
      status:'ACTIVE'
    });

  if(
    active>=product.quantity
  ){

    return {
      ok:false,
      error:
        `All RFID tags required for this product are already assigned (${active}/${product.quantity}).`,
      assignedCount:active,
      quantity:product.quantity
    };
  }

  await assignments.updateOne(
    {
      _id:a._id
    },
    {
      $set:{
        status:'ASSIGNED',
        rfidUid:rfid,
        assignedAt:new Date()
      }
    }
  );

  await inv.insertOne({

    rfidUid:rfid,

    shopId:a.shopId,

    shopName:a.shopName,

    barcode:a.barcode,

    productName:a.productName,

    status:'ACTIVE',

    assignedAt:new Date(),

    exitEventId:'',

    lastUpdated:new Date()

  });

  const assigned=
    active+1;

  await products.updateOne(
    {
      shopId:a.shopId,
      barcode:a.barcode
    },
    {
      $set:{
        rfidStatus:
          assigned>=product.quantity
            ? 'ASSIGNED'
            : 'PENDING',

        rfidUid:
          product.rfidUid ||
          rfid,

        updatedAt:
          new Date()
      }
    }
  );

  return {

    ok:true,

    action:'assigned',

    assignmentId:
      a.assignmentId,

    barcode:
      a.barcode,

    rfidUid:
      rfid,

    assignedCount:
      assigned,

    quantity:
      product.quantity,

    remainingCount:
      Math.max(
        0,
        product.quantity-assigned
      ),

    complete:
      assigned>=product.quantity

  };
}


/* =========================================================
   DASHBOARD
   ========================================================= */

async function dashboard(d,actor){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  if(!shopId){

    return {
      ok:false,
      error:
        'Shop ID required'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const [
    products,
    sales,
    user
  ]=
    await Promise.all([

      database
        .collection('products')
        .find({shopId})
        .sort({updatedAt:-1})
        .toArray(),

      database
        .collection('sales')
        .find({shopId})
        .toArray(),

      database
        .collection('users')
        .findOne({shopId})

    ]);

  const activeByBarcode=
    await database
      .collection('rfidInventory')
      .aggregate([

        {
          $match:{
            shopId,
            status:'ACTIVE'
          }
        },

        {
          $group:{
            _id:'$barcode',
            n:{
              $sum:1
            }
          }
        }

      ])
      .toArray();

  const map=
    new Map(
      activeByBarcode.map(
        x=>[
          x._id,
          x.n
        ]
      )
    );

  const output=
    products.map(
      p=>({

        row:
          String(p._id),

        barcode:
          p.barcode,

        name:
          p.name || '',

        brand:
          p.brand || '',

        category:
          p.category || '',

        mrp:
          p.mrp || '',

        sellingPrice:
          p.sellingPrice || '',

        mfd:
          p.manufacturingDate || '',

        exp:
          p.expiryDate || '',

        quantity:
          p.quantity || 0,

        rfidUid:
          p.rfidUid || '',

        rfidStatus:
          p.rfidStatus || 'PENDING',

        assignedRfids:
          map.get(p.barcode) || 0

      })
    );

  return {

    ok:true,

    shopId,

    shopName:
      user?.shopName ||
      products[0]?.shopName ||
      '',

    exitCount:
      Math.max(
        1,
        int(
          user?.exitCount,
          1
        )
      ),

    stats:{

      products:
        output.length,

      salesCount:
        sales.length,

      salesUnits:
        sales.reduce(
          (s,x)=>
            s+int(x.quantity),
          0
        ),

      salesAmount:
        sales.reduce(
          (s,x)=>
            s+num(x.total),
          0
        )

    },

    products:
      output

  };
}


/* =========================================================
   EXIT COUNT
   ========================================================= */

async function updateExitCount(
  d,
  actor
){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  const count=
    Math.min(
      20,
      Math.max(
        1,
        int(
          d.exitCount,
          1
        )
      )
    );

  if(!shopId){

    return {
      ok:false,
      error:
        'Shop ID required'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const r=
    await database
      .collection('users')
      .updateOne(
        {shopId},
        {
          $set:{
            exitCount:count
          }
        }
      );

  return r.matchedCount
    ? {
        ok:true,
        exitCount:count
      }
    : {
        ok:false,
        error:
          'Shop not found'
      };
}


/* =========================================================
   EXIT DETECT
   ========================================================= */

async function exitDetect(
  d,
  actor
){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  const shopName=
    clean(d.shopName);

  const exitNo=
    Math.max(
      1,
      int(
        d.exitNo,
        1
      )
    );

  const rfid=
    uid(d.rfidUid);

  if(
    !rfid ||
    (!shopId && !shopName)
  ){

    return {
      ok:false,
      error:
        'shopName/shopId, exitNo and rfidUid required'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const session=
    database.client.startSession();

  try{

    let result;

    await session.withTransaction(
      async()=>{

        const inv=
          database.collection(
            'rfidInventory'
          );

        const products=
          database.collection(
            'products'
          );

        const events=
          database.collection(
            'exitEvents'
          );

        const item=
          await inv.findOne(
            {
              rfidUid,
              ...(shopId
                ? {shopId}
                : {shopName})
            },
            {
              session
            }
          );

        if(!item)
          throw new Error(
            'RFID not assigned to a product in this shop'
          );

        if(
          item.status!=='ACTIVE'
        )
          throw new Error(
            'This RFID tag has already been used for this product. Scan the RFID of another available unit.'
          );

        const product=
          await products.findOne(
            {
              shopId:item.shopId,
              barcode:item.barcode
            },
            {
              session
            }
          );

        if(!product)
          throw new Error(
            'Product is no longer in active inventory for this RFID'
          );

        if(
          int(product.quantity)<=0
        )
          throw new Error(
            'Product is out of stock'
          );

        const eventId=
          'EXT'+cryptoRandom(10);

        const now=
          new Date();

        const dec=
          await products.updateOne(
            {
              shopId:item.shopId,
              barcode:item.barcode,
              quantity:{
                $gt:0
              }
            },
            {
              $inc:{
                quantity:-1
              },

              $set:{
                updatedAt:now
              }
            },
            {
              session
            }
          );

        if(!dec.modifiedCount)
          throw new Error(
            'Product is out of stock'
          );

        await inv.updateOne(
          {
            _id:item._id,
            status:'ACTIVE'
          },
          {
            $set:{
              status:'EXITED',
              exitEventId:eventId,
              lastUpdated:now
            }
          },
          {
            session
          }
        );

        await events.insertOne(
          {

            eventId,

            shopId:
              item.shopId,

            shopName:
              item.shopName ||
              shopName,

            exitNo,

            rfidUid:
              rfid,

            barcode:
              item.barcode,

            productName:
              product.name || '',

            sellingPrice:
              num(
                product.sellingPrice
              ),

            status:
              'WAITING_PAYMENT',

            saleId:'',

            createdAt:
              now,

            updatedAt:
              now

          },
          {
            session
          }
        );

        result={

          eventId,

          product:{

            barcode:
              product.barcode,

            name:
              product.name || '',

            price:
              num(
                product.sellingPrice
              )

          },

          exitNo,

          rfidUid:
            rfid,

          previousQuantity:
            int(
              product.quantity
            ),

          remainingQuantity:
            int(
              product.quantity
            )-1,

          productDeleted:false

        };

      }
    );

    return {
      ok:true,
      ...result
    };

  }catch(e){

    return {
      ok:false,
      error:e.message
    };

  }finally{

    await session.endSession();

  }
}


/* =========================================================
   EXIT EVENTS
   ========================================================= */

async function exitEvents(
  d,
  actor
){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  if(!shopId){

    return {
      ok:false,
      error:
        'shopId required'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const ev=
    await database
      .collection('exitEvents')
      .find({
        shopId,
        status:'WAITING_PAYMENT'
      })
      .sort({
        createdAt:1
      })
      .toArray();

  return {

    ok:true,

    events:
      ev.map(
        x=>({

          row:
            String(x._id),

          eventId:
            x.eventId,

          exitNo:
            x.exitNo,

          rfidUid:
            x.rfidUid,

          barcode:
            x.barcode,

          productName:
            x.productName,

          price:
            num(
              x.sellingPrice
            ),

          time:
            x.createdAt instanceof Date
              ? x.createdAt.toISOString()
              : String(
                  x.createdAt || ''
                )

        })
      ),

    count:
      ev.length

  };
}


/* =========================================================
   REMOVE EXIT EVENT
   ========================================================= */

async function removeExitEvent(
  d,
  actor
){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  const eventId=
    clean(d.eventId);

  if(
    !shopId ||
    !eventId
  ){

    return {
      ok:false,
      error:
        'shopId and eventId required'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const session=
    database.client.startSession();

  try{

    let result;

    await session.withTransaction(
      async()=>{

        const ev=
          await database
            .collection('exitEvents')
            .findOne(
              {
                shopId,
                eventId,
                status:'WAITING_PAYMENT'
              },
              {
                session
              }
            );

        if(!ev)
          throw new Error(
            'Exit event not found or already processed'
          );

        const p=
          await database
            .collection('products')
            .findOne(
              {
                shopId,
                barcode:ev.barcode
              },
              {
                session
              }
            );

        if(!p)
          throw new Error(
            'Cannot restore stock because the product no longer exists. Re-add the product before removing this exit event.'
          );

        await database
          .collection('products')
          .updateOne(
            {
              _id:p._id
            },
            {
              $inc:{
                quantity:1
              },

              $set:{
                updatedAt:
                  new Date()
              }
            },
            {
              session
            }
          );

        const inv=
          await database
            .collection('rfidInventory')
            .findOne(
              {
                shopId,
                rfidUid:
                  ev.rfidUid,

                status:
                  'EXITED'
              },
              {
                session
              }
            );

        if(inv){

          await database
            .collection('rfidInventory')
            .updateOne(
              {
                _id:inv._id
              },
              {
                $set:{
                  status:'ACTIVE',
                  exitEventId:'',
                  lastUpdated:
                    new Date()
                }
              },
              {
                session
              }
            );
        }

        await database
          .collection('exitEvents')
          .updateOne(
            {
              _id:ev._id
            },
            {
              $set:{
                status:'REMOVED',
                updatedAt:
                  new Date()
              }
            },
            {
              session
            }
          );

        result={
          ok:true,
          stockRestored:true
        };

      }
    );

    return result;

  }catch(e){

    return {
      ok:false,
      error:e.message
    };

  }finally{

    await session.endSession();

  }
}


/* =========================================================
   PAY EXIT EVENTS
   ========================================================= */

async function payExitEvents(
  d,
  actor
){

  const database=
    await getDb();

  let shopId=
    clean(d.shopId);

  let userId=
    clean(d.userId);

  let shopName=
    clean(d.shopName);

  let firebaseUid=
    clean(d.firebaseUid);

  let ids=[];

  if(
    Array.isArray(
      d.eventIds
    )
  ){

    ids=
      d.eventIds
        .map(clean)
        .filter(Boolean);

  }else if(
    typeof d.eventIds==='string'
  ){

    try{

      const x=
        JSON.parse(
          d.eventIds
        );

      ids=
        Array.isArray(x)
          ? x.map(clean).filter(Boolean)
          : [clean(x)].filter(Boolean);

    }catch{

      ids=
        d.eventIds
          .split(',')
          .map(clean)
          .filter(Boolean);

    }
  }

  if(
    !shopId &&
    firebaseUid
  ){

    const u=
      await database
        .collection('users')
        .findOne({
          firebaseUid
        });

    if(u){

      shopId=
        u.shopId;

      userId=
        userId ||
        u.userId;

      shopName=
        shopName ||
        u.shopName;

    }
  }

  if(
    !shopId &&
    shopName
  ){

    const u=
      await database
        .collection('users')
        .findOne({
          shopName
        });

    if(u){

      shopId=
        u.shopId;

      userId=
        userId ||
        u.userId;

    }
  }

  if(!shopId){

    return {
      ok:false,
      error:
        'Shop ID could not be determined. Please refresh/login again.'
    };
  }

  if(!userId){

    return {
      ok:false,
      error:
        'User ID could not be determined. Please refresh/login again.'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const session=
    database.client.startSession();

  try{

    let result;

    await session.withTransaction(
      async()=>{

        const events=
          database.collection(
            'exitEvents'
          );

        const sales=
          database.collection(
            'sales'
          );

        const q={

          shopId,

          status:
            'WAITING_PAYMENT',

          ...(ids.length
            ? {
                eventId:{
                  $in:ids
                }
              }
            : {})

        };

        const list=
          await events
            .find(
              q
            )
            .toArray();

        if(!list.length)
          throw new Error(
            'No waiting checkout events found for this shop.'
          );

        const saleIds=[];

        let total=0;

        for(
          const ev of list
        ){

          const sid=
            'SALE'+cryptoRandom(10);

          const price=
            num(
              ev.sellingPrice
            );

          await sales.insertOne(
            {

              saleId:
                sid,

              shopId,

              shopName:
                shopName ||
                ev.shopName ||
                '',

              userId,

              barcode:
                ev.barcode,

              productName:
                ev.productName,

              sellingPrice:
                price,

              quantity:1,

              total:
                price,

              createdAt:
                new Date()

            },
            {
              session
            }
          );

          await events.updateOne(
            {
              _id:
                ev._id
            },
            {
              $set:{

                status:
                  'PAID',

                saleId:
                  sid,

                updatedAt:
                  new Date()

              }
            },
            {
              session
            }
          );

          saleIds.push(sid);

          total+=price;

        }

        result={

          ok:true,

          total,

          saleIds,

          paidEvents:
            list.length,

          message:
            'Payment recorded. Bill generated on screen.'

        };

      }
    );

    return result;

  }catch(e){

    return {
      ok:false,
      error:e.message
    };

  }finally{

    await session.endSession();

  }
}


/* =========================================================
   RECORD SALE
   ========================================================= */

async function recordSale(
  d,
  actor
){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  const userId=
    clean(d.userId);

  const shopName=
    clean(d.shopName);

  const barcode=
    clean(d.barcode);

  const qty=
    Math.max(
      1,
      int(
        d.quantity,
        1
      )
    );

  if(
    !shopId ||
    !userId ||
    !barcode
  ){

    return {
      ok:false,
      error:
        'shopId, userId and barcode required'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const session=
    database.client.startSession();

  try{

    let result;

    await session.withTransaction(
      async()=>{

        const products=
          database.collection(
            'products'
          );

        const inv=
          database.collection(
            'rfidInventory'
          );

        const sales=
          database.collection(
            'sales'
          );

        const p=
          await products.findOne(
            {
              shopId,
              barcode
            },
            {
              session
            }
          );

        if(!p)
          throw new Error(
            'Product not found'
          );

        if(
          int(p.quantity)<qty
        )
          throw new Error(
            `Not enough stock. Available: ${int(p.quantity)}`
          );

        const active=
          await inv.countDocuments(
            {
              shopId,
              barcode,
              status:'ACTIVE'
            },
            {
              session
            }
          );

        if(
          active<qty
        )
          throw new Error(
            `Only ${active} active RFID tag(s) are available for this product. Assign one RFID per physical unit before selling.`
          );

        const sid=
          'SALE'+cryptoRandom(10);

        const price=
          num(
            p.sellingPrice
          );

        await sales.insertOne(
          {

            saleId:
              sid,

            shopId,

            shopName,

            userId,

            barcode,

            productName:
              p.name || '',

            sellingPrice:
              price,

            quantity:
              qty,

            total:
              price*qty,

            createdAt:
              new Date()

          },
          {
            session
          }
        );

        const tags=
          await inv
            .find({
              shopId,
              barcode,
              status:'ACTIVE'
            })
            .limit(qty)
            .toArray();

        for(
          const tag of tags
        ){

          await inv.updateOne(
            {
              _id:
                tag._id,

              status:
                'ACTIVE'
            },
            {
              $set:{

                status:
                  'SOLD',

                exitEventId:
                  sid,

                lastUpdated:
                  new Date()

              }
            },
            {
              session
            }
          );

        }

        await products.updateOne(
          {
            _id:
              p._id
          },
          {
            $inc:{
              quantity:
                -qty
            },

            $set:{
              updatedAt:
                new Date()
            }
          },
          {
            session
          }
        );

        result={

          ok:true,

          total:
            price*qty,

          saleId:
            sid,

          remainingQuantity:
            int(p.quantity)-qty,

          productDeleted:false,

          rfidsConsumed:
            tags.length

        };

      }
    );

    return result;

  }catch(e){

    return {
      ok:false,
      error:e.message
    };

  }finally{

    await session.endSession();

  }
}


/* =========================================================
   DELETE PRODUCT
   ========================================================= */

async function deleteProduct(
  d,
  actor
){

  const database=
    await getDb();

  const shopId=
    clean(d.shopId);

  const barcode=
    clean(d.barcode);

  if(
    !shopId ||
    !barcode
  ){

    return {
      ok:false,
      error:
        'Shop ID and barcode required'
    };
  }

  if(
    !canUseShop(
      actor,
      shopId
    )
  ){

    return {
      ok:false,
      error:
        'Unauthorized shop.'
    };
  }

  const p=
    await database
      .collection('products')
      .findOne({
        shopId,
        barcode
      });

  if(!p){

    return {
      ok:false,
      error:
        'Product not found'
    };
  }

  await database
    .collection('products')
    .deleteOne({
      _id:p._id
    });

  await database
    .collection('rfidInventory')
    .updateMany(
      {
        shopId,
        barcode,
        status:'ACTIVE'
      },
      {
        $set:{
          status:'UNASSIGNED',
          lastUpdated:
            new Date()
        }
      }
    );

  await database
    .collection('rfidAssignments')
    .deleteMany({
      shopId,
      barcode,
      status:'PENDING'
    });

  return {
    ok:true
  };
}


/* =========================================================
   ACTIONS
   ========================================================= */

const hardwareActions=
  new Set([
    'rfidPending',
    'assignRFID',
    'exitDetect'
  ]);

const browserActions=
  new Set([
    'loginFirebase',
    'saveProduct',
    'dashboard',
    'deleteProduct',
    'recordSale',
    'exitEvents',
    'removeExitEvent',
    'payExitEvents',
    'updateExitCount'
  ]);


/* =========================================================
   DISPATCH
   ========================================================= */

async function dispatch(req,res){

  try{

    const d={
      ...(req.query||{}),
      ...(req.body||{})
    };

    const action=
      clean(d.action) ||
      'health';

    if(
      action==='health'
    ){

      return ok(
        res,
        {
          service:
            'Smart Shop RFID API',

          version:
            '1.0-MongoDB-Express-Next'
        }
      );
    }

    let actor={
      development:true
    };

    if(
      action!=='health'
    ){

      actor=
        await authUser(
          req,
          {
            hardware:
              hardwareActions.has(
                action
              )
          }
        );

      if(
        action==='loginFirebase' &&
        actor.uid &&
        clean(d.firebaseUid) &&
        actor.uid!==clean(d.firebaseUid)
      ){

        return fail(
          res,
          'Firebase user mismatch.',
          401
        );
      }
    }

    let result;

    switch(action){

      case 'loginFirebase':

        result=
          await loginFirebase(d);

        break;


      case 'saveProduct':

        result=
          await saveProduct(
            d,
            actor
          );

        break;


      case 'dashboard':

        result=
          await dashboard(
            d,
            actor
          );

        break;


      case 'deleteProduct':

        result=
          await deleteProduct(
            d,
            actor
          );

        break;


      case 'recordSale':

        result=
          await recordSale(
            d,
            actor
          );

        break;


      case 'rfidPending':

        result=
          await rfidPending(d);

        break;


      case 'assignRFID':

        result=
          await assignRFID(
            d,
            actor
          );

        break;


      case 'exitDetect':

        result=
          await exitDetect(
            d,
            actor
          );

        break;


      case 'exitEvents':

        result=
          await exitEvents(
            d,
            actor
          );

        break;


      case 'removeExitEvent':

        result=
          await removeExitEvent(
            d,
            actor
          );

        break;


      case 'payExitEvents':

        result=
          await payExitEvents(
            d,
            actor
          );

        break;


      case 'updateExitCount':

        result=
          await updateExitCount(
            d,
            actor
          );

        break;


      default:

        return fail(
          res,
          `Unknown action: ${action}`,
          404
        );
    }

    if(
      result.ok===false
    ){

      return fail(
        res,
        result.error,
        400,
        result
      );
    }

    return ok(
      res,
      Object.fromEntries(
        Object.entries(result)
          .filter(
            ([k])=>k!=='ok'
          )
      )
    );

  }catch(e){

    console.error(
      'API error:',
      e?.message || e
    );

    return fail(
      res,
      e.message || 'Server error',
      e.status || 500
    );
  }
}


/* =========================================================
   ROUTES
   ========================================================= */

app.get(
  '/',
  dispatch
);

app.post(
  '/',
  dispatch
);

app.get(
  '/api',
  dispatch
);

app.post(
  '/api',
  dispatch
);


/* =========================================================
   EXPORT
   ========================================================= */

module.exports=app;
