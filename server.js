const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const xlsx = require('xlsx');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// File upload configuration
const upload = multer({ dest: 'uploads/' });

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'admin_dashboard',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database tables
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Create dynamic data table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS uploaded_data (
        id INT AUTO_INCREMENT PRIMARY KEY,
        data JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create schools table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schools (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        status ENUM('pending', 'started', 'completed') DEFAULT 'pending',
        start_date DATE,
        deadline DATE,
        priority INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Create columns configuration table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS table_columns (
        id INT AUTO_INCREMENT PRIMARY KEY,
        column_name VARCHAR(255) NOT NULL UNIQUE,
        data_type VARCHAR(50) DEFAULT 'VARCHAR(255)',
        is_core BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Insert default core columns if not exists
    await connection.query(`
      INSERT IGNORE INTO table_columns (column_name, is_core) VALUES
      ('id', TRUE),
      ('name', TRUE),
      ('email', TRUE),
      ('school', FALSE)
    `);
    
    connection.release();
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Get all columns
app.get('/api/columns', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM table_columns ORDER BY id');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new column
app.post('/api/columns', async (req, res) => {
  try {
    const { column_name } = req.body;
    const [result] = await pool.query(
      'INSERT INTO table_columns (column_name) VALUES (?)',
      [column_name]
    );
    res.json({ id: result.insertId, column_name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete column
app.delete('/api/columns/:name', async (req, res) => {
  try {
    const { name } = req.params;
    await pool.query(
      'DELETE FROM table_columns WHERE column_name = ? AND is_core = FALSE',
      [name]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload Excel file
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    
    // Auto-detect columns from Excel headers
    if (data.length > 0) {
      const headers = Object.keys(data[0]);
      for (const header of headers) {
        try {
          await pool.query(
            'INSERT IGNORE INTO table_columns (column_name) VALUES (?)',
            [header]
          );
        } catch (err) {
          console.log('Column already exists:', header);
        }
      }
    }
    
    // Store data
    for (const row of data) {
      await pool.query(
        'INSERT INTO uploaded_data (data) VALUES (?)',
        [JSON.stringify(row)]
      );
    }
    
    res.json({ success: true, count: data.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all uploaded data
app.get('/api/data', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM uploaded_data ORDER BY id DESC');
    const data = rows.map(row => ({
      id: row.id,
      ...JSON.parse(row.data),
      created_at: row.created_at
    }));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Filter data
app.post('/api/data/filter', async (req, res) => {
  try {
    const filters = req.body;
    const [rows] = await pool.query('SELECT * FROM uploaded_data');
    
    let filteredData = rows.map(row => ({
      id: row.id,
      ...JSON.parse(row.data)
    }));
    
    // Apply filters
    Object.keys(filters).forEach(key => {
      if (filters[key]) {
        filteredData = filteredData.filter(item =>
          item[key]?.toString().toLowerCase().includes(filters[key].toLowerCase())
        );
      }
    });
    
    res.json(filteredData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schools CRUD operations

// Get all schools
app.get('/api/schools', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM schools 
      ORDER BY 
        CASE status 
          WHEN 'started' THEN 1 
          WHEN 'pending' THEN 2 
          WHEN 'completed' THEN 3 
        END, 
        priority ASC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new school
app.post('/api/schools', async (req, res) => {
  try {
    const { name, status, start_date, deadline, priority } = req.body;
    const [result] = await pool.query(
      'INSERT INTO schools (name, status, start_date, deadline, priority) VALUES (?, ?, ?, ?, ?)',
      [name, status || 'pending', start_date, deadline, priority || 1]
    );
    res.json({ id: result.insertId, ...req.body });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update school status
app.put('/api/schools/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, start_date, deadline } = req.body;
    await pool.query(
      'UPDATE schools SET status = ?, start_date = ?, deadline = ? WHERE id = ?',
      [status, start_date, deadline, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete school
app.delete('/api/schools/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM schools WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get deadline notifications
app.get('/api/notifications', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM schools 
      WHERE status = 'started' 
      AND deadline IS NOT NULL 
      AND DATEDIFF(deadline, CURDATE()) <= 7
      AND DATEDIFF(deadline, CURDATE()) > 0
    `);
    
    const notifications = rows.map(school => ({
      id: school.id,
      message: `${school.name}: ${Math.ceil((new Date(school.deadline) - new Date()) / (1000 * 60 * 60 * 24))} days until deadline`
    }));
    
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
  });
}

startServer();